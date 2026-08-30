/**
 * 工作台分行与 FCP Title 字幕分块的共享规则。
 * UMD：Node 用 require，浏览器通过 window.SubtitleBlocks 使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubtitleBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PARAGRAPH_GAP = 0.4;

  function buildParagraphs(words, gapThreshold) {
    const threshold = gapThreshold == null ? PARAGRAPH_GAP : gapThreshold;
    const paragraphs = [];
    let current = { startTime: 0, items: [] };
    let firstWord = true;

    (words || []).forEach((word, idx) => {
      if (word.isGap && (word.end - word.start) >= threshold && current.items.length > 0) {
        current.items.push({ word, idx });
        paragraphs.push(current);
        current = { startTime: word.end, items: [] };
      } else {
        if (firstWord && !word.isGap) {
          current.startTime = word.start;
          firstWord = false;
        }
        current.items.push({ word, idx });
      }
    });
    if (current.items.length) paragraphs.push(current);
    return paragraphs;
  }

  function visualWidth(text) {
    let width = 0;
    for (const char of Array.from(text || '')) {
      width += /[\x00-\x7F]/.test(char) ? 0.5 : 1;
    }
    return width;
  }

  function splitRun(tokens, maxWidth) {
    const chunks = [];
    let rest = tokens.slice();
    while (rest.length) {
      let width = 0;
      let overflowAt = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const nextWidth = width + visualWidth(rest[i].word.text);
        if (i > 0 && nextWidth > maxWidth) { overflowAt = i; break; }
        width = nextWidth;
      }

      if (overflowAt === rest.length) {
        chunks.push(rest);
        break;
      }

      let splitAt = overflowAt;
      for (let i = overflowAt; i > 0; i--) {
        if (rest[i] && rest[i].breakBefore) { splitAt = i; break; }
      }
      chunks.push(rest.slice(0, splitAt));
      rest = rest.slice(splitAt);
      if (rest.length) rest[0] = Object.assign({}, rest[0], { breakBefore: false });
    }
    return chunks;
  }

  function buildSubtitleBlocks({ words, selectedIndices, finalKeeps, maxWidth }) {
    const selected = new Set(selectedIndices || []);
    const keeps = finalKeeps || [];
    const keepOffsets = [];
    let timelineCursor = 0;
    for (const keep of keeps) {
      keepOffsets.push(timelineCursor);
      timelineCursor += keep.end - keep.start;
    }
    const limit = maxWidth == null ? 14 : maxWidth;
    const blocks = [];

    for (const paragraph of buildParagraphs(words)) {
      const runs = [];
      let run = [];
      let runKeep = -1;
      let sawGap = false;

      for (const item of paragraph.items) {
        if (item.word.isGap) { sawGap = true; continue; }
        if (selected.has(item.idx)) continue;
        const midpoint = (item.word.start + item.word.end) / 2;
        const keepIndex = keeps.findIndex(keep => midpoint >= keep.start && midpoint <= keep.end);
        if (keepIndex < 0) continue;
        if (run.length && keepIndex !== runKeep) {
          runs.push(run);
          run = [];
        }
        runKeep = keepIndex;
        run.push({ word: item.word, idx: item.idx, keepIndex, breakBefore: sawGap && run.length > 0 });
        sawGap = false;
      }
      if (run.length) runs.push(run);

      for (const tokens of runs) {
        for (const chunk of splitRun(tokens, limit)) {
          const keepIndex = chunk[0].keepIndex;
          const keep = keeps[keepIndex];
          const timelineStart = keepOffsets[keepIndex] + chunk[0].word.start - keep.start;
          const timelineEnd = keepOffsets[keepIndex] + chunk[chunk.length - 1].word.end - keep.start;
          blocks.push({
            text: chunk.map(token => token.word.text).join(''),
            sourceStart: chunk[0].word.start,
            sourceEnd: chunk[chunk.length - 1].word.end,
            timelineStart: Math.round(timelineStart * 1000000) / 1000000,
            timelineEnd: Math.round(timelineEnd * 1000000) / 1000000,
            keepIndex,
          });
        }
      }
    }
    return blocks;
  }

  return { buildParagraphs, buildSubtitleBlocks, visualWidth, PARAGRAPH_GAP };
});
