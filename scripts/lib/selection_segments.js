/**
 * 把工作台的词级选择转换为时间区间。
 *
 * 只有索引连续且都被选中的元素才合并；任何被恢复的词或空白都会切断删除段。
 * UMD：Node 用 require，浏览器通过 window.SelectionSegments 使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SelectionSegments = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function selectedIndicesToSegments(words, selectedIndices) {
    const selected = new Set(selectedIndices || []);
    const segments = [];
    let current = null;

    (words || []).forEach((word, index) => {
      if (!selected.has(index)) {
        if (current) segments.push(current);
        current = null;
        return;
      }

      if (!current) current = { start: word.start, end: word.end };
      else current.end = Math.max(current.end, word.end);
    });
    if (current) segments.push(current);
    return segments;
  }

  return { selectedIndicesToSegments };
});
