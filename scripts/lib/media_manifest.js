'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIRECT_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav']);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function probeMedia(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`媒体文件不存在: ${resolved}`);
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,start_time,format_name:stream=codec_type,codec_name,sample_rate,channels',
    '-of', 'json',
    resolved,
  ], { encoding: 'utf8' });
  const info = JSON.parse(raw);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const hasVideo = streams.some(stream => stream.codec_type === 'video');
  const duration = parseFloat(info.format && info.format.duration) || 0;
  if (!audio || !(duration > 0)) throw new Error(`媒体不包含可用音频: ${resolved}`);
  return {
    extension: path.extname(resolved).slice(1).toLowerCase(),
    sizeBytes: fs.statSync(resolved).size,
    formatName: String((info.format && info.format.format_name) || ''),
    duration,
    startTime: parseFloat(info.format && info.format.start_time) || 0,
    hasAudio: true,
    hasVideo,
    audioCodec: String(audio.codec_name || ''),
    sampleRate: parseInt(audio.sample_rate, 10) || 0,
    channels: parseInt(audio.channels, 10) || 0,
  };
}

function isDirectAudio(media) {
  return media.hasAudio && !media.hasVideo && DIRECT_AUDIO_EXTENSIONS.has(media.extension);
}

function buildManifest({ sourcePath, analysisPath, mode, sourceMedia }) {
  const source = path.resolve(sourcePath);
  const analysis = path.resolve(analysisPath);
  const sourceSha256 = sha256(source);
  const analysisSha256 = analysis === source ? sourceSha256 : sha256(analysis);
  return {
    version: 1,
    mode,
    sourcePath: source,
    analysisPath: analysis,
    playbackPath: mode === 'direct-audio' ? source : source,
    exportPath: source,
    sourceSha256,
    analysisSha256,
    media: sourceMedia || probeMedia(source),
    generatedAt: new Date().toISOString(),
  };
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(path.resolve(manifestPath)), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function loadAndVerifyManifest(manifestPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  if (manifest.version !== 1) throw new Error(`不支持的媒体清单版本: ${manifest.version}`);
  for (const field of ['sourcePath', 'analysisPath', 'playbackPath', 'exportPath', 'sourceSha256', 'analysisSha256']) {
    if (!manifest[field]) throw new Error(`媒体清单缺少字段: ${field}`);
  }
  if (manifest.mode === 'direct-audio') {
    const directPaths = ['sourcePath', 'analysisPath', 'playbackPath', 'exportPath']
      .map(field => path.resolve(manifest[field]));
    if (!directPaths.every(mediaPath => mediaPath === directPaths[0])) {
      throw new Error('直通音频的转写、波形、播放和导出必须使用同一个原文件');
    }
  }
  for (const field of ['sourcePath', 'analysisPath', 'playbackPath', 'exportPath']) {
    if (!fs.existsSync(manifest[field])) throw new Error(`媒体清单引用的文件不存在: ${manifest[field]}`);
  }
  if (sha256(manifest.sourcePath) !== manifest.sourceSha256) {
    throw new Error(`原始媒体内容已变化: ${manifest.sourcePath}`);
  }
  const actualAnalysisSha = manifest.analysisPath === manifest.sourcePath
    ? manifest.sourceSha256
    : sha256(manifest.analysisPath);
  if (actualAnalysisSha !== manifest.analysisSha256) {
    throw new Error(`分析媒体内容已变化: ${manifest.analysisPath}`);
  }
  return manifest;
}

module.exports = {
  DIRECT_AUDIO_EXTENSIONS,
  buildManifest,
  isDirectAudio,
  loadAndVerifyManifest,
  probeMedia,
  sha256,
  writeManifest,
};
