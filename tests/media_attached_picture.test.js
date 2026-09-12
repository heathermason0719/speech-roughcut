'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeAudio, makeCfrVideo } = require('./helpers/media_fixtures');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roughcut-attached-pic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function addPicture(source, output) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', source,
    '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.04',
    '-map', '0', '-map', '1:v:0', '-c', 'copy',
    '-c:v', 'mjpeg', '-frames:v', '1', '-disposition:v:0', 'attached_pic',
    '-y', output,
  ]);
  const info = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type:stream_disposition=attached_pic',
    '-of', 'json', output,
  ], { encoding: 'utf8' }));
  assert.equal(info.streams.filter(stream => stream.disposition.attached_pic === 1).length, 1);
  return output;
}

for (const extension of ['mp3', 'm4a']) {
  test(`attached_pic ${extension} uses the pure-audio review path without altering the source`, (t) => {
    const dir = fixture(t);
    const source = addPicture(makeAudio(dir, extension), path.join(dir, `covered.${extension}`));
    const before = digest(source);
    const output = path.join(dir, 'transcribe');
    execFileSync(process.execPath, [prepareScript, source, output]);
    const context = JSON.parse(fs.readFileSync(path.join(output, 'media_context.json'), 'utf8'));
    assert.equal(context.mediaType, 'audio');
    assert.equal(context.source.video, undefined);
    assert.equal(context.playbackPath, context.reviewAudioPath);
    assert.equal(context.exportPath, source);
    assert.equal(context.timebase.kind, 'audio-samples');
    assert.equal(digest(source), before);
  });
}

test('two main video streams still fail before review audio is written', (t) => {
  const dir = fixture(t);
  const single = makeCfrVideo(dir, 'mp4');
  const source = path.join(dir, 'multi-video.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', single, '-map', '0:v:0', '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy', '-y', source,
  ]);
  const before = digest(source);
  const output = path.join(dir, 'transcribe');
  const result = spawnSync(process.execPath, [prepareScript, source, output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /单视频流/);
  assert.equal(fs.existsSync(path.join(output, 'review_audio.mp3')), false);
  assert.equal(digest(source), before);
});

test('a CFR main video remains the selected timeline when an attached picture is present', (t) => {
  const dir = fixture(t);
  const single = makeCfrVideo(dir, 'mp4');
  const source = path.join(dir, 'video-with-cover.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', single, '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=0.04',
    '-map', '0', '-map', '1:v:0', '-c', 'copy', '-c:v:1', 'mjpeg',
    '-disposition:v:1', 'attached_pic', '-y', source,
  ]);
  const before = digest(source);
  const output = path.join(dir, 'transcribe');
  execFileSync(process.execPath, [prepareScript, source, output]);
  const context = JSON.parse(fs.readFileSync(path.join(output, 'media_context.json'), 'utf8'));
  assert.equal(context.mediaType, 'video');
  assert.equal(context.source.video.codec, 'h264');
  assert.equal(context.source.video.width, 160);
  assert.equal(context.source.video.fpsNum, 30000);
  assert.equal(context.source.video.fpsDen, 1001);
  assert.equal(context.playbackPath, source);
  assert.equal(digest(source), before);
});
