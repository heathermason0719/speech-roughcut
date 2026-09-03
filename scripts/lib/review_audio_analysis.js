'use strict';

const { streamDecodedPcm } = require('./pcm_stream');
const { annotateCandidateSources } = require('./refine_boundaries');
const {
  ANALYSIS_FRAME_SAMPLES,
  ANALYSIS_HOP_SAMPLES,
  PEAK_BUCKET_SAMPLES,
  REVIEW_SAMPLE_RATE,
} = require('./time_contract');

function amplitudeDb(value) {
  return value > 0 ? 20 * Math.log10(value) : -120;
}

function createAccumulator({ sampleRate }) {
  if (ANALYSIS_FRAME_SAMPLES !== ANALYSIS_HOP_SAMPLES
      || ANALYSIS_FRAME_SAMPLES !== PEAK_BUCKET_SAMPLES) {
    throw new Error('当前流式分析要求 frame、hop 和 peak bucket 使用同一冻结样本宽度');
  }
  let byteCarry = Buffer.alloc(0);
  let frameStartSample = 0;
  let frameSampleCount = 0;
  let frameSumSquares = 0;
  let framePeak = 0;
  let decodedSampleCount = 0;
  let overallPeak = 0;
  const frames = [];
  const peaks = [];

  const finishFrame = () => {
    if (!frameSampleCount) return;
    const rms = Math.sqrt(frameSumSquares / frameSampleCount);
    frames.push({
      startSample: frameStartSample,
      endSample: frameStartSample + frameSampleCount,
      rmsDb: amplitudeDb(rms),
    });
    peaks.push(Number(framePeak.toFixed(6)));
    frameStartSample += frameSampleCount;
    frameSampleCount = 0;
    frameSumSquares = 0;
    framePeak = 0;
  };

  const push = chunk => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    const bytes = byteCarry.length ? Buffer.concat([byteCarry, chunk]) : chunk;
    const evenLength = bytes.length - (bytes.length % 2);
    byteCarry = evenLength < bytes.length ? Buffer.from(bytes.subarray(evenLength)) : Buffer.alloc(0);
    for (let offset = 0; offset < evenLength; offset += 2) {
      const normalized = bytes.readInt16LE(offset) / 32768;
      const absolute = Math.abs(normalized);
      frameSumSquares += normalized * normalized;
      if (absolute > framePeak) framePeak = absolute;
      if (absolute > overallPeak) overallPeak = absolute;
      frameSampleCount += 1;
      decodedSampleCount += 1;
      if (frameSampleCount === ANALYSIS_FRAME_SAMPLES) finishFrame();
    }
  };

  const finish = ({ silenceThresholdDb, silenceThresholds, minimumSilenceSamples, asrBreaks }) => {
    if (byteCarry.length) throw new Error('PCM 输入包含不完整的 16-bit sample');
    finishFrame();
    const defaultThresholdDb = Number.isFinite(silenceThresholdDb)
      ? silenceThresholdDb
      : Math.max(-55, Math.min(-20, amplitudeDb(overallPeak) - 35));
    const requestedThresholds = Array.isArray(silenceThresholds)
      ? silenceThresholds.filter(Number.isFinite)
      : [];
    const thresholds = [...new Set(requestedThresholds.length
      ? requestedThresholds
      : [defaultThresholdDb])].sort((left, right) => right - left);
    const minimumSamples = Number.isFinite(minimumSilenceSamples)
      ? Math.max(1, Math.round(minimumSilenceSamples))
      : Math.round(0.2 * sampleRate);
    const candidatesForThreshold = thresholdDb => {
      const candidates = [];
      let run = [];
      const flushRun = () => {
        if (!run.length) return;
        const startSample = run[0].startSample;
        const endSample = run[run.length - 1].endSample;
        if (endSample - startSample >= minimumSamples) {
          let maxDb = -120;
          let sumDb = 0;
          for (const frame of run) {
            if (frame.rmsDb > maxDb) maxDb = frame.rmsDb;
            sumDb += frame.rmsDb;
          }
          const thresholdId = thresholds.length > 1
            ? `${thresholdDb < 0 ? 'm' : 'p'}${String(Math.abs(thresholdDb)).replace('.', '_')}-`
            : '';
          candidates.push({
            id: `silence-${thresholdId}${startSample}-${endSample}`,
            startSample,
            endSample,
            energy: {
              maxDb: Number(maxDb.toFixed(3)),
              meanDb: Number((sumDb / run.length).toFixed(3)),
            },
            thresholdDb,
          });
        }
        run = [];
      };
      for (const frame of frames) {
        if (frame.rmsDb <= thresholdDb) run.push(frame);
        else flushRun();
      }
      flushRun();
      return annotateCandidateSources(candidates, asrBreaks, sampleRate);
    };
    return {
      peaks: {
        sampleRate,
        decodedSampleCount,
        bucketSamples: PEAK_BUCKET_SAMPLES,
        values: peaks,
      },
      detectedSilence: thresholds.flatMap(candidatesForThreshold),
      analysis: {
        frameSamples: ANALYSIS_FRAME_SAMPLES,
        hopSamples: ANALYSIS_HOP_SAMPLES,
        thresholdDb: thresholds.length === 1 ? thresholds[0] : null,
        thresholds,
      },
    };
  };

  return { push, finish };
}

async function analyzePcmReadable(readable, options = {}) {
  const sampleRate = Number(options.sampleRate) || REVIEW_SAMPLE_RATE;
  const accumulator = createAccumulator({ sampleRate });
  for await (const chunk of readable) accumulator.push(chunk);
  return accumulator.finish(options);
}

async function analyzeReviewAudio(audioFile, options = {}) {
  const sampleRate = Number(options.sampleRate) || REVIEW_SAMPLE_RATE;
  const accumulator = createAccumulator({ sampleRate });
  const decodedSampleCount = await streamDecodedPcm(audioFile, {
    sampleRate,
    streamIndex: options.streamIndex,
    onChunk: accumulator.push,
  });
  const result = accumulator.finish(options);
  if (result.peaks.decodedSampleCount !== decodedSampleCount) {
    throw new Error('流式 PCM sample count 内部不一致');
  }
  return result;
}

module.exports = {
  analyzePcmReadable,
  analyzeReviewAudio,
};
