'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');
const generateReviewScript = path.resolve(__dirname, '../scripts/generate_review.js');
const serverScript = path.resolve(__dirname, '../scripts/review_server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('审核服务器启动超时')), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY_PORT=')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`审核服务器提前退出: ${code}\n${output}`));
    });
  });
}

const formats = {
  mp3: { codec: 'libmp3lame', mime: 'audio/mpeg' },
  m4a: { codec: 'aac', mime: 'audio/mp4' },
  wav: { codec: 'pcm_s16le', mime: 'audio/wav' },
};

for (const [ext, format] of Object.entries(formats)) {
  test(`${ext} 从转写到审核、播放和 FCPXML 始终引用同一原文件`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `speech-roughcut-flow-${ext}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, `source.${ext}`);
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=660:sample_rate=48000:duration=1',
      '-c:a', format.codec, source,
    ]);

    const transcribeDir = path.join(root, '1_转录');
    const reviewDir = path.join(root, '3_审核');
    const wordsFile = path.join(root, 'words.json');
    const selectedFile = path.join(root, 'selected.json');
    fs.writeFileSync(wordsFile, JSON.stringify([
      { text: '测', start: 0.1, end: 0.3, isGap: false },
      { text: '试', start: 0.3, end: 0.5, isGap: false },
    ]));
    fs.writeFileSync(selectedFile, '[]');

    execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
    const sourceManifest = path.join(transcribeDir, 'media_manifest.json');
    execFileSync(process.execPath, [
      generateReviewScript, wordsFile, selectedFile, sourceManifest, reviewDir,
    ]);

    const reviewManifest = path.join(reviewDir, 'media_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(reviewManifest, 'utf8'));
    assert.equal(manifest.analysisPath, path.resolve(source));
    assert.equal(manifest.playbackPath, path.resolve(source));
    assert.equal(manifest.exportPath, path.resolve(source));
    assert.equal(fs.existsSync(path.join(transcribeDir, 'audio.mp3')), false);
    assert.equal(fs.existsSync(path.join(reviewDir, 'audio.mp3')), false);
    assert.ok(JSON.parse(fs.readFileSync(path.join(reviewDir, 'peaks.json'), 'utf8')).peaks.length > 0);

    const port = await freePort();
    const child = spawn(process.execPath, [serverScript, String(port), reviewManifest], {
      cwd: reviewDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGTERM'));
    await waitUntilReady(child);

    const mediaResponse = await fetch(`http://127.0.0.1:${port}/video`);
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get('content-type'), format.mime);
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), fs.readFileSync(source));

    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteList: [], finalSelected: [], includeTitles: false }),
    });
    assert.equal(exportResponse.status, 200);
    const exportResult = await exportResponse.json();
    assert.equal(exportResult.success, true);
    const xml = fs.readFileSync(exportResult.output, 'utf8');
    assert.match(xml, new RegExp(pathToFileURL(source).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
