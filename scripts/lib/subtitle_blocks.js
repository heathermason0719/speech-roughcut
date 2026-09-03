(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubtitleBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PARAGRAPH_BREAK_SECONDS = 0.4;

  function buildParagraphs({
    words = [],
    asrBreaks = [],
    reviewSampleRate,
    paragraphBreakSeconds = PARAGRAPH_BREAK_SECONDS,
  }) {
    if (!(Number.isInteger(reviewSampleRate) && reviewSampleRate > 0)) {
      throw new Error('reviewSampleRate 无效');
    }
    const breakByPair = new Map();
    for (const item of asrBreaks) {
      if (!item || !item.id || !Number.isInteger(item.startSample)
          || !Number.isInteger(item.endSample) || item.endSample < item.startSample) {
        throw new Error('asrBreak 合同无效');
      }
      breakByPair.set(`${item.previousWordId}\u0000${item.nextWordId}`, item);
    }
    const minimumBreakSamples = Math.round(paragraphBreakSeconds * reviewSampleRate);
    const paragraphs = [];
    let currentWords = [];
    const flush = breakAfter => {
      if (!currentWords.length) return;
      paragraphs.push({
        startSample: currentWords[0].startSample,
        endSample: currentWords[currentWords.length - 1].endSample,
        wordIds: currentWords.map(word => word.id),
        words: currentWords,
        breakAfter: breakAfter || null,
      });
      currentWords = [];
    };
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (!word || !word.id || !Number.isInteger(word.startSample)
          || !Number.isInteger(word.endSample) || word.endSample <= word.startSample) {
        throw new Error(`word 合同无效: ${index}`);
      }
      currentWords.push(word);
      const next = words[index + 1];
      const boundary = next && breakByPair.get(`${word.id}\u0000${next.id}`);
      if (boundary && boundary.endSample - boundary.startSample >= minimumBreakSamples) {
        flush(boundary);
      }
    }
    flush(null);
    return paragraphs;
  }

  return { buildParagraphs, PARAGRAPH_BREAK_SECONDS };
});
