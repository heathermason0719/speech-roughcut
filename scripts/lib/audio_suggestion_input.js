'use strict';
const crypto = require('node:crypto');
const { validateAudioSuggestions } = require('./audio_suggestions');

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
  return validateAudioSuggestions(envelope.suggestions, input.words, input.mediaContext.review.decodedSampleCount);
}

module.exports = { audioSuggestionInputHash, readAudioSuggestionInput };
