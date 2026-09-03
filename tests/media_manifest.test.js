'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SAMPLE_RATE,
  decodedSampleCount,
  makeAudio,
  makeCfrVideo,
  makeMismatchedAvVideo,
  makeMultiAudioVideo,
  makeNonZeroStartAudio,
  makeTimestampGapAudio,
  makeVfrVideo,
} = require('./helpers/media_fixtures');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function withTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function prepare(source, transcribeDir) {
  return execFileSync(process.execPath, [prepareScript, source, transcribeDir], {
    encoding: 'utf8',
  }).trim();
}

function probeAudio(filePath) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate',
    '-of', 'json', filePath,
  ], { encoding: 'utf8' })).streams[0];
}

for (const extension of ['mp3', 'm4a', 'wav']) {
  test(`${extension} 生成统一 review_audio.mp3 且原始资产不变`, (t) => {
    const root = withTempDir(t, `speech-roughcut-${extension}-`);
    const source = makeAudio(root, extension);
    const before = sha256(source);
    const transcribeDir = path.join(root, '1_转录');

    const reviewPath = prepare(source, transcribeDir);
    const context = JSON.parse(fs.readFileSync(path.join(transcribeDir, 'media_context.json'), 'utf8'));

    assert.equal(reviewPath, path.join(transcribeDir, 'review_audio.mp3'));
    assert.equal(context.sourcePath, path.resolve(source));
    assert.equal(context.reviewAudioPath, path.resolve(reviewPath));
    assert.equal(context.playbackPath, path.resolve(reviewPath));
    assert.equal(context.exportPath, path.resolve(source));
    assert.equal(context.mediaType, 'audio');
    assert.equal(context.review.sampleRate, SAMPLE_RATE);
    assert.equal(context.review.channels, 1);
    assert.equal(context.review.bitrateKbps, 64);
    const actualReview = probeAudio(reviewPath);
    assert.equal(actualReview.codec_name, 'mp3');
    assert.equal(actualReview.sample_rate, '48000');
    assert.equal(actualReview.channels, 1);
    assert.equal(Number(actualReview.bit_rate), 64000);
    assert.equal(context.review.decodedSampleCount, decodedSampleCount(reviewPath));
    assert.equal(context.review.duration, context.review.decodedSampleCount / SAMPLE_RATE);
    assert.ok(context.review.skipSamples > 0);
    assert.ok(context.review.discardPaddingSamples >= 0);
    assert.equal(context.review.gaplessMetadataVerified, true);
    assert.ok(Math.abs(decodedSampleCount(source) - context.review.decodedSampleCount) <= 1);
    assert.equal(context.timebase.kind, 'audio-samples');
    assert.equal(context.timebase.ticksPerSecond, context.source.sampleRate);
    assert.equal(context.offsets.playerPresentationOffset.status, 'verified');
    assert.equal(context.offsets.sourceMediaOffset.status, 'verified');
    assert.equal(context.offsets.asrPresentationOffset.status, 'pending_user_validation');
    assert.deepEqual(Object.keys(context.sourceFingerprint).sort(), ['dev', 'inode', 'mtimeNs', 'size']);
    assert.deepEqual(Object.keys(context.reviewFingerprint).sort(), ['dev', 'inode', 'mtimeNs', 'size']);
    assert.equal('version' in context, false);
    assert.equal('sourceSha256' in context, false);
    assert.equal('analysisSha256' in context, false);
    assert.equal(sha256(source), before);
  });
}

for (const extension of ['mp4', 'm4v', 'mov']) {
  test(`CFR ${extension} 保留原视频播放和导出并生成审核音频`, (t) => {
    const root = withTempDir(t, `speech-roughcut-cfr-${extension}-`);
    const source = makeCfrVideo(root, extension);
    const before = sha256(source);
    const transcribeDir = path.join(root, '1_转录');

    const reviewPath = prepare(source, transcribeDir);
    const context = JSON.parse(fs.readFileSync(path.join(transcribeDir, 'media_context.json'), 'utf8'));

    assert.equal(context.mediaType, 'video');
    assert.equal(context.playbackPath, path.resolve(source));
    assert.equal(context.exportPath, path.resolve(source));
    assert.equal(context.reviewAudioPath, path.resolve(reviewPath));
    assert.equal(context.source.video.fpsNum, 30000);
    assert.equal(context.source.video.fpsDen, 1001);
    assert.equal(context.source.video.isCfr, true);
    assert.equal(context.source.video.endpointsSynchronized, true);
    assert.ok(Number.isFinite(context.source.video.presentationEnd));
    assert.ok(Number.isFinite(context.source.audioPresentationEnd));
    assert.ok(
      Math.abs(context.source.video.presentationEnd - context.source.audioPresentationEnd)
        <= context.source.video.fpsDen / context.source.video.fpsNum,
    );
    assert.equal(context.timebase.kind, 'video-frames');
    assert.equal(context.timebase.fpsNum, 30000);
    assert.equal(context.timebase.fpsDen, 1001);
    assert.ok(Math.abs(decodedSampleCount(source) - context.review.decodedSampleCount) <= 1);
    assert.equal(sha256(source), before);
  });
}

for (const mismatch of [
  { videoDuration: 1, audioDuration: 2, name: 'audio-longer.mp4' },
  { videoDuration: 2, audioDuration: 1, name: 'video-longer.mp4' },
]) {
  test(`CFR 音画终点不一致在生成审核文件前 fail closed: ${mismatch.name}`, (t) => {
    const root = withTempDir(t, 'speech-roughcut-av-endpoint-');
    const source = makeMismatchedAvVideo(root, mismatch);
    const transcribeDir = path.join(root, '1_转录');
    const result = spawnSync(process.execPath, [prepareScript, source, transcribeDir], {
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /音画.*终点.*一致/);
    assert.equal(fs.existsSync(path.join(transcribeDir, 'review_audio.mp3')), false);
  });
}

test('多个音轨在生成审核文件前 fail closed', (t) => {
  const root = withTempDir(t, 'speech-roughcut-multi-audio-');
  const source = makeMultiAudioVideo(root);
  const transcribeDir = path.join(root, '1_转录');
  const result = spawnSync(process.execPath, [prepareScript, source, transcribeDir], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只支持一个连续主音轨/);
  assert.equal(fs.existsSync(path.join(transcribeDir, 'review_audio.mp3')), false);
});

test('VFR 在生成审核文件和任何上传之前 fail closed', (t) => {
  const root = withTempDir(t, 'speech-roughcut-vfr-');
  const source = makeVfrVideo(root);
  const transcribeDir = path.join(root, '1_转录');
  const result = spawnSync(process.execPath, [prepareScript, source, transcribeDir], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /仅支持 CFR，请先转码为 CFR 后重新执行/);
  assert.equal(fs.existsSync(path.join(transcribeDir, 'review_audio.mp3')), false);
});

test('非零 presentation start 明确失败', (t) => {
  const root = withTempDir(t, 'speech-roughcut-offset-');
  const source = makeNonZeroStartAudio(root);
  const result = spawnSync(process.execPath, [prepareScript, source, path.join(root, '1_转录')], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /presentation start.*必须为 0/);
});

test('音频时间戳跳变明确失败', (t) => {
  const root = withTempDir(t, 'speech-roughcut-gap-');
  const source = makeTimestampGapAudio(root);
  const result = spawnSync(process.execPath, [prepareScript, source, path.join(root, '1_转录')], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /时间戳.*连续|连续.*时间戳/);
});

test('轻量指纹在源资产或审核音频变化后拒绝继续', (t) => {
  const root = withTempDir(t, 'speech-roughcut-fingerprint-');
  const source = makeAudio(root, 'wav');
  const transcribeDir = path.join(root, '1_转录');
  prepare(source, transcribeDir);
  const contextPath = path.join(transcribeDir, 'media_context.json');
  const { loadAndVerifyMediaContext } = require('../scripts/lib/media_manifest');

  fs.utimesSync(source, new Date(), new Date(Date.now() + 1000));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /原始媒体.*已变化/);

  prepare(source, transcribeDir);
  const refreshed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  fs.appendFileSync(refreshed.reviewAudioPath, Buffer.from([0]));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /审核音频.*已变化/);
});

test('media context 无法证明 rate=1 时 fail closed', (t) => {
  const root = withTempDir(t, 'speech-roughcut-rate-');
  const source = makeAudio(root, 'wav');
  const transcribeDir = path.join(root, '1_转录');
  prepare(source, transcribeDir);
  const contextPath = path.join(transcribeDir, 'media_context.json');
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  context.source.rate = 0.5;
  fs.writeFileSync(contextPath, JSON.stringify(context));
  const { loadAndVerifyMediaContext } = require('../scripts/lib/media_manifest');

  assert.throws(() => loadAndVerifyMediaContext(contextPath), /rate=1/);
});

test('重开当前 invocation 时仍拒绝非零 source start 与失效 CFR 证明', (t) => {
  const root = withTempDir(t, 'speech-roughcut-reopen-gates-');
  const source = makeCfrVideo(root, 'mp4');
  const transcribeDir = path.join(root, '1_转录');
  prepare(source, transcribeDir);
  const contextPath = path.join(transcribeDir, 'media_context.json');
  const original = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const { loadAndVerifyMediaContext } = require('../scripts/lib/media_manifest');

  const nonZero = structuredClone(original);
  nonZero.source.presentationStart = 0.25;
  fs.writeFileSync(contextPath, JSON.stringify(nonZero));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /presentation start.*必须为 0/);

  const notCfr = structuredClone(original);
  notCfr.source.video.isCfr = false;
  fs.writeFileSync(contextPath, JSON.stringify(notCfr));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /仅支持 CFR/);

  const endpointsInvalid = structuredClone(original);
  endpointsInvalid.source.video.endpointsSynchronized = false;
  fs.writeFileSync(contextPath, JSON.stringify(endpointsInvalid));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /音画流终点同步/);

  const invalidSampleRate = structuredClone(original);
  invalidSampleRate.source.sampleRate = 0;
  fs.writeFileSync(contextPath, JSON.stringify(invalidSampleRate));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /源音轨.*采样率/);

  const invalidFrameRate = structuredClone(original);
  invalidFrameRate.source.video.fpsNum = 0;
  invalidFrameRate.timebase.fpsNum = 0;
  fs.writeFileSync(contextPath, JSON.stringify(invalidFrameRate));
  assert.throws(() => loadAndVerifyMediaContext(contextPath), /CFR timebase/);
});
