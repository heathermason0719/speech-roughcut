(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TitlePlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function visualWidth(text) {
    let width = 0;
    for (const char of Array.from(text || '')) width += /[\x00-\x7F]/.test(char) ? 0.5 : 1;
    return width;
  }

  function planTitleBlocks({
    words,
    retainedWordIds,
    asrBreaks,
    keeps,
    wordTickRanges,
    reviewSampleRate,
    maxVisualWidth = 14,
  }) {
    const retained = new Set(retainedWordIds || []);
    const breakPairs = new Map();
    for (const item of asrBreaks || []) {
      breakPairs.set(`${item.previousWordId}\u0000${item.nextWordId}`, item.endSample - item.startSample);
    }
    const tokens = [];
    let previousRetained = null;
    for (const word of words || []) {
      if (!retained.has(word.id)) continue;
      const range = wordTickRanges[word.id];
      if (!range) continue;
      // A cut can remove the midpoint while retaining audible word fragments.
      // Assign the word once to its largest surviving overlap (earlier on ties).
      let keepIndex = -1;
      let largestOverlap = 0;
      for (let index = 0; index < keeps.length; index += 1) {
        const keep = keeps[index];
        const overlap = Math.min(range.sourceEndTick, keep.sourceEndTick)
          - Math.max(range.sourceStartTick, keep.sourceStartTick);
        if (overlap > largestOverlap) {
          largestOverlap = overlap;
          keepIndex = index;
        }
      }
      if (keepIndex < 0) continue;
      const breakSamples = previousRetained
        ? breakPairs.get(`${previousRetained.id}\u0000${word.id}`)
        : 0;
      tokens.push({
        word,
        range,
        keepIndex,
        paragraphBreak: Number(breakSamples) >= 0.4 * reviewSampleRate,
      });
      previousRetained = word;
    }

    const groups = [];
    let current = [];
    let currentWidth = 0;
    const flush = () => {
      if (current.length) groups.push(current);
      current = [];
      currentWidth = 0;
    };
    for (const token of tokens) {
      const width = visualWidth(token.word.text);
      if (current.length && (token.keepIndex !== current[0].keepIndex
          || token.paragraphBreak
          || currentWidth + width > maxVisualWidth)) {
        flush();
      }
      current.push(token);
      currentWidth += width;
    }
    flush();

    return groups.map((group, index) => {
      const keepIndex = group[0].keepIndex;
      const keep = keeps[keepIndex];
      const sourceStartTick = Math.max(keep.sourceStartTick, group[0].range.sourceStartTick);
      const sourceEndTick = Math.min(keep.sourceEndTick, group[group.length - 1].range.sourceEndTick);
      const reviewStartSample = Math.max(
        Number.isInteger(keep.reviewStartSample) ? keep.reviewStartSample : 0,
        group[0].word.startSample,
      );
      const reviewEndSample = Math.min(
        Number.isInteger(keep.reviewEndSample) ? keep.reviewEndSample : Number.MAX_SAFE_INTEGER,
        group[group.length - 1].word.endSample,
      );
      return {
        id: `title-${String(index).padStart(4, '0')}`,
        text: group.map(token => token.word.text).join(''),
        keepIndex,
        sourceStartTick,
        sourceEndTick,
        outputStartTick: keep.outputStartTick + sourceStartTick - keep.sourceStartTick,
        outputEndTick: keep.outputStartTick + sourceEndTick - keep.sourceStartTick,
        reviewStartSample,
        reviewEndSample,
        wordIds: group.map(token => token.word.id),
      };
    }).filter(block => block.outputEndTick > block.outputStartTick
      && block.reviewEndSample > block.reviewStartSample);
  }

  return { planTitleBlocks, visualWidth };
});
