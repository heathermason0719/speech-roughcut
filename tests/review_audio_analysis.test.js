'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const {
  SAMPLE_RATE,
  writeMonoWav,
} = require('./helpers/media_fixtures');

let analysis = {};
try {
  analysis = require('../scripts/lib/review_audio_analysis');
} catch (_) {
  // RED: 流式 sample-domain 分析模块尚未实现。
}

function withTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function toReviewMp3(wavPath, outputPath) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', wavPath,
    '-af', 'aresample=48000:async=0,asetpts=N/SR/TB',
    '-ac', '1', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-write_xing', '1', '-y', outputPath,
  ]);
  return outputPath;
}

function overlaps(candidate, startSeconds, endSeconds) {
  return candidate.startSample < endSeconds * SAMPLE_RATE
    && candidate.endSample > startSeconds * SAMPLE_RATE;
}

test('有声 ASR break 不产生静音，无 word 的低能量区仍被全局 PCM 发现', async (t) => {
  assert.equal(typeof analysis.analyzeReviewAudio, 'function');
  const root = withTempDir(t, 'speech-roughcut-analysis-');
  const wav = writeMonoWav(path.join(root, 'pattern.wav'), {
    duration: 1.2,
    sampleAt(_index, time) {
      if (time >= 0.25 && time < 0.55) return 0.7 * Math.sin(2 * Math.PI * 1000 * time);
      return 0;
    },
  });
  const review = toReviewMp3(wav, path.join(root, 'review_audio.mp3'));
  const result = await analysis.analyzeReviewAudio(review, {
    silenceThresholdDb: -35,
    minimumSilenceSamples: 0.15 * SAMPLE_RATE,
    asrBreaks: [{ id: 'break-audible', start: 0.25, end: 0.55 }],
  });

  assert.equal(result.peaks.sampleRate, SAMPLE_RATE);
  assert.equal(result.peaks.bucketSamples, 480);
  assert.equal(result.peaks.values.length, Math.ceil(result.peaks.decodedSampleCount / 480));
  assert.equal(result.detectedSilence.some(item => overlaps(item, 0.30, 0.50)), false);
  assert.equal(result.detectedSilence.some(item => overlaps(item, 0.0, 0.20)), true);
  assert.equal(result.detectedSilence.some(item => overlaps(item, 0.65, 1.1)), true);
  for (const item of result.detectedSilence) {
    assert.equal(Number.isInteger(item.startSample), true);
    assert.equal(Number.isInteger(item.endSample), true);
    assert.ok(item.endSample > item.startSample);
    assert.equal(typeof item.energy.maxDb, 'number');
    assert.equal(item.thresholdDb, -35);
    assert.ok(['global', 'asr-window'].includes(item.candidateSource));
  }
});

test('静音阈值变化会改变具有 PCM 证据的候选', async (t) => {
  const root = withTempDir(t, 'speech-roughcut-threshold-');
  const wav = writeMonoWav(path.join(root, 'quiet.wav'), {
    duration: 1,
    sampleAt(_index, time) {
      if (time >= 0.2 && time < 0.8) return 0.02 * Math.sin(2 * Math.PI * 600 * time);
      return 0;
    },
  });
  const review = toReviewMp3(wav, path.join(root, 'review_audio.mp3'));
  const strict = await analysis.analyzeReviewAudio(review, {
    silenceThresholdDb: -50,
    minimumSilenceSamples: 0.1 * SAMPLE_RATE,
  });
  const permissive = await analysis.analyzeReviewAudio(review, {
    silenceThresholdDb: -30,
    minimumSilenceSamples: 0.1 * SAMPLE_RATE,
  });

  assert.equal(strict.detectedSilence.some(item => overlaps(item, 0.3, 0.7)), false);
  assert.equal(permissive.detectedSilence.some(item => overlaps(item, 0.3, 0.7)), true);
});

test('一次流式解码可冻结工作台全部阈值的独立 PCM 候选边界', async (t) => {
  const root = withTempDir(t, 'speech-roughcut-threshold-variants-');
  const wav = writeMonoWav(path.join(root, 'quiet.wav'), {
    duration: 1,
    sampleAt(_index, time) {
      if (time >= 0.2 && time < 0.8) return 0.02 * Math.sin(2 * Math.PI * 600 * time);
      return 0;
    },
  });
  const review = toReviewMp3(wav, path.join(root, 'review_audio.mp3'));
  const result = await analysis.analyzeReviewAudio(review, {
    silenceThresholds: [-30, -50],
    minimumSilenceSamples: 0.1 * SAMPLE_RATE,
  });
  const permissive = result.detectedSilence.filter(item => item.thresholdDb === -30);
  const strict = result.detectedSilence.filter(item => item.thresholdDb === -50);
  assert.equal(permissive.some(item => overlaps(item, 0.3, 0.7)), true);
  assert.equal(strict.some(item => overlaps(item, 0.3, 0.7)), false);
  assert.equal(new Set(result.detectedSilence.map(item => item.id)).size, result.detectedSilence.length);
});

test('长 PCM 输入按流消费且不依赖 child_process maxBuffer', async () => {
  assert.equal(typeof analysis.analyzePcmReadable, 'function');
  const seconds = 75;
  const totalBytes = seconds * SAMPLE_RATE * 2;
  const chunks = [];
  for (let offset = 0; offset < totalBytes; offset += 4097) {
    chunks.push(Buffer.alloc(Math.min(4097, totalBytes - offset)));
  }
  const result = await analysis.analyzePcmReadable(Readable.from(chunks), {
    sampleRate: SAMPLE_RATE,
    silenceThresholdDb: -35,
    minimumSilenceSamples: 0.2 * SAMPLE_RATE,
  });

  assert.equal(result.peaks.decodedSampleCount, seconds * SAMPLE_RATE);
  assert.equal(result.detectedSilence.length, 1);
  assert.deepEqual(
    [result.detectedSilence[0].startSample, result.detectedSilence[0].endSample],
    [0, seconds * SAMPLE_RATE],
  );
});
