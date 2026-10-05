'use strict';
const crypto = require('node:crypto');
const { validateAudioSuggestions } = require('./audio_suggestions');
const { prepareSeams } = require('./seam_preparation');

function audioSuggestionInputHash({ words, mediaContext }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    sourceFingerprint: mediaContext.sourceFingerprint,
    reviewSampleRate: mediaContext.review.sampleRate,
    reviewDecodedSampleCount: mediaContext.review.decodedSampleCount,
    words,
  })).digest('hex');
}

function readAudioSuggestionInput(envelope, input) {
  if (!envelope || envelope.inputHash !== audioSuggestionInputHash(input)) {
    throw new Error('音频建议的输入 hash 与当前录音／转写身份不一致');
  }
  if (!Array.isArray(envelope.suggestions)) throw new Error('音频建议必须为数组');
  if (envelope.seamPreparation) validateSeamInputBinding(envelope.seamPreparation,input);
  const generated = envelope.seamPreparation ? prepareSeams(envelope.seamPreparation, input.words,
    input.initialSuggestedWordDeletes, input.mediaContext.review.decodedSampleCount).suggestions : [];
  return validateAudioSuggestions([...envelope.suggestions, ...generated], input.words, input.mediaContext.review.decodedSampleCount);
}

function seamInputHash({words,mediaContext,initialSuggestedWordDeletes}) {
  return crypto.createHash('sha256').update(JSON.stringify({words,mediaContext,
    initialSuggestedWordDeletes:[...initialSuggestedWordDeletes].sort()})).digest('hex');
}
function validateSeamInputBinding(preparation, input) {
  if (preparation.inputHash !== seamInputHash(input)) throw new Error('接缝输入 hash 与媒体、clock、offset 或初选不一致');
}
module.exports = { audioSuggestionInputHash, readAudioSuggestionInput, seamInputHash, validateSeamInputBinding };
