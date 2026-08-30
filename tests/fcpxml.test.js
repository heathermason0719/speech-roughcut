'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFcpxml } = require('../scripts/lib/fcpxml');

function makeAudioFixture(dir) {
  const audioFile = path.join(dir, 'speech.wav');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=44100:duration=4',
    '-c:a', 'pcm_s16le',
    audioFile,
  ]);
  return audioFile;
}

function makeVideoFixture(dir) {
  const videoFile = path.join(dir, 'speech.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'color=color=black:size=640x360:rate=25:duration=4',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    videoFile,
  ]);
  return videoFile;
}

test('纯音频 FCPXML 使用采样率时基并准确引用每个保留区间', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const audioFile = makeAudioFixture(tempDir);
  const { xml, finalKeeps } = buildFcpxml({
    mediaFile: audioFile,
    deleteList: [{ start: 1, end: 2 }],
    silencePeriods: [],
    cutOpts: {
      mergeGap: 0,
      minKeepDur: 0.01,
      lookBack: 0,
      padStart: 0,
      padEnd: 0,
      minInternalSilence: 99,
    },
  });

  assert.deepEqual(finalKeeps, [
    { start: 0, end: 1 },
    { start: 2, end: 4 },
  ]);
  assert.doesNotMatch(xml, /(?:^|[="'])\d+\/0s(?:["']|$)/);
  assert.match(xml, /<asset [^>]*hasAudio="1"[^>]*hasVideo="0"/);
  assert.match(xml, /<asset [^>]*audioRate="44\.1k"/);
  assert.doesNotMatch(xml, /<asset [^>]*format="r2"/);
  assert.match(xml, /<asset-clip [^>]*offset="0\/44100s"[^>]*start="0\/44100s"[^>]*duration="44100\/44100s"[^>]*srcEnable="audio"/);
  assert.match(xml, /<asset-clip [^>]*offset="44100\/44100s"[^>]*start="88200\/44100s"[^>]*duration="88200\/44100s"[^>]*srcEnable="audio"/);
  assert.match(xml, /<sequence duration="132300\/44100s"/);
});

test('视频 FCPXML 继续使用原有帧时基和视频资产声明', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const videoFile = makeVideoFixture(tempDir);
  const { xml } = buildFcpxml({
    videoFile,
    deleteList: [{ start: 1, end: 2 }],
    silencePeriods: [],
    cutOpts: {
      mergeGap: 0,
      minKeepDur: 0.01,
      lookBack: 0,
      padStart: 0,
      padEnd: 0,
      minInternalSilence: 99,
    },
  });

  assert.match(xml, /<format id="r2" frameDuration="1\/25s" width="640" height="360"/);
  assert.match(xml, /<asset [^>]*format="r2"[^>]*hasAudio="1"[^>]*hasVideo="1"/);
  assert.match(xml, /<asset-clip [^>]*offset="0\/25s"[^>]*start="0\/25s"[^>]*duration="25\/25s"[^>]*format="r2"/);
  assert.match(xml, /<asset-clip [^>]*offset="25\/25s"[^>]*start="50\/25s"[^>]*duration="50\/25s"[^>]*format="r2"/);
  assert.match(xml, /<sequence duration="75\/25s"/);
});

test('开启字幕时为保留文字生成连接在媒体片段上的可编辑 Basic Title', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const audioFile = makeAudioFixture(tempDir);
  const { xml } = buildFcpxml({
    mediaFile: audioFile,
    deleteList: [{ start: 1, end: 2 }],
    silencePeriods: [],
    cutOpts: {
      mergeGap: 0,
      minKeepDur: 0.01,
      lookBack: 0,
      padStart: 0,
      padEnd: 0,
      minInternalSilence: 99,
    },
    includeTitles: true,
    selectedIndices: [2],
    subtitleWords: [
      { text: '第一句', start: 0.1, end: 0.8, isGap: false },
      { text: '', start: 0.8, end: 1.2, isGap: true },
      { text: '删除文字', start: 1.2, end: 1.8, isGap: false },
      { text: '', start: 1.8, end: 2.2, isGap: true },
      { text: '第二句', start: 2.2, end: 2.8, isGap: false },
    ],
  });

  assert.match(xml, /<effect id="r3" name="Basic Title" uid="[^"]*Basic Title\.moti"/);
  assert.equal((xml.match(/<title /g) || []).length, 2);
  assert.match(xml, /<asset-clip[^>]*start="0\/44100s"[^>]*>[\s\S]*?<title [^>]*lane="1"[^>]*>[\s\S]*?第一句[\s\S]*?<\/title>[\s\S]*?<\/asset-clip>/);
  assert.match(xml, /<asset-clip[^>]*start="88200\/44100s"[^>]*>[\s\S]*?<title [^>]*lane="1"[^>]*>[\s\S]*?第二句[\s\S]*?<\/title>[\s\S]*?<\/asset-clip>/);
  assert.doesNotMatch(xml, /删除文字/);
});
