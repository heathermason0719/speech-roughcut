'use strict';

const { isDeepStrictEqual } = require('node:util');
const { deriveAsrBreaks } = require('./transcript_model');

function assertFields(value, fields, label) {
  if (Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error(`${label} 包含 canonical version 1 合同之外的字段`);
  }
}

function validateCanonicalTranscript(canonical, mediaContext) {
  const review = mediaContext && mediaContext.review;
  if (!review || !Number.isSafeInteger(review.sampleRate) || review.sampleRate <= 0
      || !Number.isSafeInteger(review.decodedSampleCount) || review.decodedSampleCount <= 0) {
    throw new Error('media context 的 review sample clock 无效');
  }
  if (!canonical || canonical.version !== 1 || !Array.isArray(canonical.words)
      || !Array.isArray(canonical.asrBreaks)) {
    throw new Error('canonical transcript 必须使用 version 1 words/asrBreaks 合同');
  }
  assertFields(canonical, ['version', 'words', 'asrBreaks'], 'canonical transcript');
  if (canonical.words.length === 0) throw new Error('canonical transcript 不允许空 words');
  const ids = new Set();
  let previousStart = -1;
  for (const word of canonical.words) {
    if (!word || typeof word.id !== 'string' || !word.id.trim() || ids.has(word.id)) {
      throw new Error('canonical word ID 必须非空且唯一');
    }
    assertFields(word, ['id', 'text', 'startSample', 'endSample'], 'canonical word');
    if (typeof word.text !== 'string' || !word.text.trim()) {
      throw new Error(`canonical word 必须包含非空文本: ${word.id}`);
    }
    if (!Number.isSafeInteger(word.startSample) || !Number.isSafeInteger(word.endSample)
        || word.startSample < 0 || word.endSample <= word.startSample
        || word.endSample > review.decodedSampleCount) {
      throw new Error(`canonical word 超出有效审核 sample clock: ${word.id}`);
    }
    if (word.startSample < previousStart) throw new Error('canonical words 必须按时间单调排列');
    previousStart = word.startSample;
    ids.add(word.id);
  }
  const expectedBreaks = deriveAsrBreaks(canonical.words, { minimumBreakSamples: 1 });
  if (!isDeepStrictEqual(canonical.asrBreaks, expectedBreaks)) {
    throw new Error('canonical asrBreaks 必须由相邻 words 的时间关系派生');
  }
  return canonical;
}

module.exports = { validateCanonicalTranscript };
