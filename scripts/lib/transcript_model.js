'use strict';

function assertAsrOffset(offset) {
  if (!offset || !Number.isFinite(offset.seconds)
      || !['pending_user_validation', 'verified'].includes(offset.status)) {
    throw new Error('asrPresentationOffset 状态无效');
  }
}

function normalizeProviderWords(rawWords, {
  reviewSampleRate,
  asrPresentationOffset,
}) {
  if (!(reviewSampleRate > 0)) throw new Error('reviewSampleRate 必须为正数');
  assertAsrOffset(asrPresentationOffset);
  const normalized = [];
  for (const item of rawWords || []) {
    if (!item || !String(item.text || '').trim()) continue;
    const asrStart = Number(item.start_time) / 1000;
    const asrEnd = Number(item.end_time) / 1000;
    if (!Number.isFinite(asrStart) || !Number.isFinite(asrEnd)
        || asrStart < 0 || asrEnd <= asrStart) {
      throw new Error(`provider 非空 word 时间无效: ${String(item.text)}`);
    }
    const reviewStart = asrStart - asrPresentationOffset.seconds;
    const reviewEnd = asrEnd - asrPresentationOffset.seconds;
    if (reviewStart < 0 || !(reviewEnd > reviewStart)) {
      throw new Error('ASR 时间映射后超出审核 sample clock');
    }
    normalized.push({
      id: `word-${String(normalized.length).padStart(6, '0')}`,
      text: String(item.text),
      startSample: Math.round(reviewStart * reviewSampleRate),
      endSample: Math.round(reviewEnd * reviewSampleRate),
    });
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startSample < normalized[index - 1].startSample) {
      throw new Error('ASR words 必须按时间单调排列');
    }
  }
  return normalized;
}

function deriveAsrBreaks(words, {
  minimumBreakSamples,
} = {}) {
  const minimum = Number.isFinite(minimumBreakSamples) ? Math.max(0, minimumBreakSamples) : 0;
  const breaks = [];
  for (let index = 1; index < (words || []).length; index += 1) {
    const previous = words[index - 1];
    const next = words[index];
    const startSample = previous.endSample;
    const endSample = next.startSample;
    if (endSample - startSample < minimum) continue;
    breaks.push({
      id: `asr-break-${previous.id}-${next.id}`,
      startSample,
      endSample,
      previousWordId: previous.id,
      nextWordId: next.id,
    });
  }
  return breaks;
}

module.exports = {
  deriveAsrBreaks,
  normalizeProviderWords,
};
