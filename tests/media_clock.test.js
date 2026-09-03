'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { makeMarkerWav, SAMPLE_RATE } = require('./helpers/media_fixtures');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

let analysis = {};
try {
  analysis = require('../scripts/lib/review_audio_analysis');
} catch (_) {
  // RED: 新时钟分析模块尚未实现。
}
const timeContract = require('../scripts/lib/time_contract');

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-clock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function markerOnsetBucket(peaks, expectedSample) {
  const expectedIndex = Math.floor(expectedSample / peaks.bucketSamples);
  for (let index = Math.max(0, expectedIndex - 2); index <= Math.min(peaks.values.length - 1, expectedIndex + 2); index += 1) {
    if (peaks.values[index] >= 0.2) return index * peaks.bucketSamples;
  }
  throw new Error(`未在 ${expectedSample} 附近找到声学标记起点`);
}

test('审核 MP3 的开头、中段、结尾声学标记保持固定偏移且无累计漂移', async (t) => {
  assert.equal(typeof analysis.analyzeReviewAudio, 'function');
  const root = withTempDir(t);
  const markers = [0.1, 0.7, 1.3];
  const source = makeMarkerWav(root, { markers, duration: 1.5 });
  const transcribeDir = path.join(root, '1_转录');
  const review = execFileSync(process.execPath, [prepareScript, source, transcribeDir], {
    encoding: 'utf8',
  }).trim();
  const sourceAnalysis = await analysis.analyzeReviewAudio(source, { silenceThresholdDb: -35 });
  const reviewAnalysis = await analysis.analyzeReviewAudio(review, { silenceThresholdDb: -35 });
  const offsets = markers.map(marker => {
    const expectedSample = Math.round(marker * SAMPLE_RATE);
    const sourceSample = markerOnsetBucket(sourceAnalysis.peaks, expectedSample);
    const reviewSample = markerOnsetBucket(reviewAnalysis.peaks, expectedSample);
    assert.ok(Math.abs(sourceSample - expectedSample) <= 480);
    assert.ok(Math.abs(reviewSample - expectedSample) <= 480);
    return reviewSample - sourceSample;
  });

  assert.ok(Math.max(...offsets) - Math.min(...offsets) <= 480);
  assert.equal(reviewAnalysis.peaks.sampleRate, 48000);
  assert.equal(reviewAnalysis.peaks.bucketSamples / reviewAnalysis.peaks.sampleRate, 480 / 48000);
  assert.equal('duration' in reviewAnalysis.peaks, false);
});

test('冻结容差由实际分辨率公式给出明确数值', () => {
  assert.equal(timeContract.TIME_TOLERANCES.reviewSampleSeconds, 1 / 48000);
  assert.equal(timeContract.TIME_TOLERANCES.analysisBoundarySeconds, 480 / 48000);
  assert.equal(timeContract.TIME_TOLERANCES.peakBucketSeconds, 480 / 48000);
  assert.equal(timeContract.TIME_TOLERANCES.asrFixedOffsetSeconds, Math.max(0.001, 480 / 48000));
  assert.equal(timeContract.TIME_TOLERANCES.asrManualWaveformSeconds, Math.max(0.001, 480 / 48000) + 480 / 48000);
});
