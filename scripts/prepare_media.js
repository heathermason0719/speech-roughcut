#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  buildManifest,
  isDirectAudio,
  probeMedia,
  writeManifest,
} = require('./lib/media_manifest');

const sourceArg = process.argv[2];
const transcribeDirArg = process.argv[3];

if (!sourceArg || !transcribeDirArg) {
  console.error('用法: node prepare_media.js <source_media> <transcribe_dir>');
  process.exit(1);
}

try {
  const sourcePath = path.resolve(sourceArg);
  const transcribeDir = path.resolve(transcribeDirArg);
  fs.mkdirSync(transcribeDir, { recursive: true });

  const sourceMedia = probeMedia(sourcePath);
  let analysisPath = sourcePath;
  let mode = 'direct-audio';

  if (!isDirectAudio(sourceMedia)) {
    mode = 'legacy-proxy';
    analysisPath = path.join(transcribeDir, 'audio.mp3');
    execFileSync('ffmpeg', [
      '-v', 'error', '-i', sourcePath,
      '-vn', '-acodec', 'libmp3lame', '-y', analysisPath,
    ]);
  }

  const manifest = buildManifest({ sourcePath, analysisPath, mode, sourceMedia });
  const manifestPath = path.join(transcribeDir, 'media_manifest.json');
  writeManifest(manifestPath, manifest);
  console.error(mode === 'direct-audio'
    ? `✅ 兼容音频直通: ${sourcePath}`
    : `✅ 已生成分析代理: ${analysisPath}`);
  process.stdout.write(analysisPath + '\n');
} catch (error) {
  console.error(`❌ 媒体准备失败: ${error.message}`);
  process.exit(1);
}
