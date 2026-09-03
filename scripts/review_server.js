#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { buildFcpxml } = require('./lib/fcpxml');
const { writeArtifactPair } = require('./lib/artifact_pair');
const { buildLearningDiff, serializeLearningDiff } = require('./lib/learning_diff');
const { loadAndVerifyMediaContext } = require('./lib/media_manifest');

const PORT = process.argv[2] || 8899;
const CONTEXT_FILE = process.argv[3];

if (!CONTEXT_FILE) {
  console.error('❌ 错误: 必须指定 media_context.json');
  console.error('用法: node review_server.js [port] <media_context.json>');
  process.exit(1);
}

let initialContext;
try {
  initialContext = loadAndVerifyMediaContext(CONTEXT_FILE);
} catch (error) {
  console.error(`❌ 错误: media context 校验失败: ${error.message}`);
  process.exit(1);
}

const PLAYBACK_FILE = initialContext.playbackPath;
const EXPORT_FILE = initialContext.exportPath;
const REVIEW_DATA_FILE = path.resolve(process.cwd(), 'data.json');
let latestExportPath = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
};

const SHARED_LIBRARIES = new Map([
  ['/lib/edit_state.js', 'edit_state.js'],
  ['/lib/title_plan.js', 'title_plan.js'],
  ['/lib/compile_edit.js', 'compile_edit.js'],
  ['/lib/subtitle_blocks.js', 'subtitle_blocks.js'],
  ['/lib/review_workbench.js', 'review_workbench.js'],
]);

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function streamFile(response, filePath, request, contentType) {
  if (!filePath || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  if (request.headers.range) {
    const match = String(request.headers.range).match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isInteger(start) || start < 0 || start > end || start >= stat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(response);
}

function readJsonBody(request, maximumBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maximumBytes) {
        reject(new Error('请求体过大'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function readReviewData() {
  if (!fs.existsSync(REVIEW_DATA_FILE)) {
    throw new Error(`审核数据不存在: ${REVIEW_DATA_FILE}`);
  }
  const data = JSON.parse(fs.readFileSync(REVIEW_DATA_FILE, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !Array.isArray(data.words) || !Array.isArray(data.initialSuggestedWordDeletes)) {
    throw new Error('data.json 不是当前审核数据格式');
  }
  return data;
}

function sameSortedIds(left, right) {
  return JSON.stringify([...new Set(left.map(String))].sort())
    === JSON.stringify([...new Set(right.map(String))].sort());
}

let initialReviewData;
try {
  initialReviewData = readReviewData();
  if (!isDeepStrictEqual(initialReviewData.mediaContext, initialContext)) {
    throw new Error('data.json 与 media_context.json 不属于同一 invocation');
  }
} catch (error) {
  console.error(`❌ 错误: 审核数据校验失败: ${error.message}`);
  process.exit(1);
}

function verifyFrozenInvocation() {
  const currentContext = loadAndVerifyMediaContext(CONTEXT_FILE);
  const currentReviewData = readReviewData();
  if (!isDeepStrictEqual(currentContext, initialContext)
      || !isDeepStrictEqual(currentReviewData, initialReviewData)) {
    throw new Error('当前 invocation 的 media context 或审核数据已变化');
  }
  return { mediaContext: initialContext, reviewData: initialReviewData };
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

const server = http.createServer(async (request, response) => {
  if (!originAllowed(request)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestPath = request.url.split('?')[0];
  if (request.method === 'GET' && SHARED_LIBRARIES.has(requestPath)) {
    const filePath = path.join(__dirname, 'lib', SHARED_LIBRARIES.get(requestPath));
    streamFile(response, filePath, request, MIME_TYPES['.js']);
    return;
  }

  if (request.method === 'GET' && requestPath === '/video') {
    const contentType = MIME_TYPES[path.extname(PLAYBACK_FILE).toLowerCase()]
      || 'application/octet-stream';
    streamFile(response, PLAYBACK_FILE, request, contentType);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/fcpxml') {
    try {
      const payload = await readJsonBody(request);
      const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload)
        : [];
      if (!payload || Array.isArray(payload) || !payload.compiledCutPlan
          || keys.some(key => !['compiledCutPlan', 'includeTitles'].includes(key))) {
        throw new Error('导出请求必须只提供 compiledCutPlan 与 includeTitles');
      }
      const { mediaContext: currentContext, reviewData } = verifyFrozenInvocation();
      const result = buildFcpxml({
        mediaContext: currentContext,
        compiledCutPlan: payload.compiledCutPlan,
        includeTitles: payload.includeTitles !== false,
        outputDirectory: process.cwd(),
      });
      if (!sameSortedIds(
        reviewData.initialSuggestedWordDeletes,
        payload.compiledCutPlan.wordDecisions.initialSuggestedWordDeleteIds,
      )) {
        throw new Error('compiledCutPlan 的 AI 初始词决定与 data.json 不一致');
      }
      const learningDiff = buildLearningDiff({
        mediaName: path.basename(currentContext.sourcePath),
        words: reviewData.words,
        initialSuggestedWordDeleteIds:
          payload.compiledCutPlan.wordDecisions.initialSuggestedWordDeleteIds,
        finalDeletedWordIds: payload.compiledCutPlan.wordDecisions.finalDeletedWordIds,
      });
      const learningDiffPath = path.resolve(process.cwd(), 'learning_diff.json');
      writeArtifactPair([
        { path: result.outputPath, data: result.xml },
        { path: learningDiffPath, data: serializeLearningDiff(learningDiff) },
      ]);
      latestExportPath = result.outputPath;
      console.log(`✅ 导出 FCPXML: ${result.outputPath} (${result.finalKeeps.length} 片段)`);
      jsonResponse(response, 200, {
        success: true,
        output: result.outputPath,
        downloadUrl: '/api/download/fcpxml',
        learningDiff: learningDiffPath,
        segments: result.finalKeeps.length,
      });
    } catch (error) {
      const fingerprintMismatch = /轻量指纹|invocation.*变化/.test(error.message);
      console.error(`❌ FCPXML 导出失败: ${error.message}`);
      jsonResponse(response, fingerprintMismatch ? 409 : 400, {
        success: false,
        error: error.message,
      });
    }
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/download/fcpxml') {
    if (!latestExportPath || !fs.existsSync(latestExportPath)) {
      response.writeHead(404);
      response.end('Not Found');
      return;
    }
    const rawName = path.basename(latestExportPath);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(rawName)}`,
    );
    streamFile(response, latestExportPath, request, 'application/octet-stream');
    return;
  }

  if (request.method === 'GET' && requestPath.startsWith('/api/download/')) {
    response.writeHead(404);
    response.end('Not Found');
    return;
  }

  if (request.method !== 'GET') {
    response.writeHead(405);
    response.end('Method Not Allowed');
    return;
  }
  const relative = requestPath === '/' ? 'review.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(process.cwd(), relative);
  const root = `${path.resolve(process.cwd())}${path.sep}`;
  if (filePath !== path.resolve(process.cwd()) && !filePath.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()]
    || 'application/octet-stream';
  streamFile(response, filePath, request, contentType);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  try {
    fs.writeFileSync('server_url.txt', `${url}\n`);
    fs.writeFileSync('.review_server.pid', `${process.pid}\n`);
  } catch (_error) {
    // 地址仍会打印到标准输出；辅助文件失败不影响当前 invocation 的前台服务。
  }
  console.log(`READY_PORT=${PORT}`);
  console.log(`\n🎬 审核服务器已启动\n📍 地址: ${url}\n🎙️ 播放媒体: ${PLAYBACK_FILE}\n📎 导出源资产: ${EXPORT_FILE}\n`);
});
