'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeAudio(dir, ext) {
  const file = path.join(dir, `source.${ext}`);
  const codec = ext === 'wav' ? 'pcm_s16le' : (ext === 'm4a' ? 'aac' : 'libmp3lame');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=880:sample_rate=48000:duration=0.5',
    '-c:a', codec, file,
  ]);
  return file;
}

for (const ext of ['mp3', 'm4a', 'wav']) {
  test(`${ext} 音频直通且不生成派生 audio.mp3`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `speech-roughcut-${ext}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = makeAudio(root, ext);
    const transcribeDir = path.join(root, '1_转录');

    execFileSync(process.execPath, [prepareScript, source, transcribeDir]);

    const manifestPath = path.join(transcribeDir, 'media_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const resolvedSource = path.resolve(source);
    assert.equal(manifest.mode, 'direct-audio');
    assert.equal(manifest.sourcePath, resolvedSource);
    assert.equal(manifest.analysisPath, resolvedSource);
    assert.equal(manifest.playbackPath, resolvedSource);
    assert.equal(manifest.exportPath, resolvedSource);
    assert.equal(manifest.sourceSha256, sha256(source));
    assert.equal(manifest.analysisSha256, manifest.sourceSha256);
    assert.equal(manifest.media.extension, ext);
    assert.equal(manifest.media.hasAudio, true);
    assert.equal(manifest.media.hasVideo, false);
    assert.ok(manifest.media.duration > 0);
    assert.equal(fs.existsSync(path.join(transcribeDir, 'audio.mp3')), false);
  });
}

test('媒体清单在原始音频被替换后拒绝继续使用', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = makeAudio(root, 'wav');
  const transcribeDir = path.join(root, '1_转录');
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);

  const manifestPath = path.join(transcribeDir, 'media_manifest.json');
  fs.appendFileSync(source, Buffer.from([0, 1, 2, 3]));

  const { loadAndVerifyManifest } = require('../scripts/lib/media_manifest');
  assert.throws(
    () => loadAndVerifyManifest(manifestPath),
    /原始媒体内容已变化/,
  );
});

test('直通音频清单拒绝混用另一份播放媒体', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-single-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = makeAudio(root, 'mp3');
  const transcribeDir = path.join(root, '1_转录');
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);

  const manifestPath = path.join(transcribeDir, 'media_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const other = path.join(root, 'other.mp3');
  fs.copyFileSync(source, other);
  manifest.playbackPath = other;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const { loadAndVerifyManifest } = require('../scripts/lib/media_manifest');
  assert.throws(
    () => loadAndVerifyManifest(manifestPath),
    /直通音频.*同一个原文件/,
  );
});
