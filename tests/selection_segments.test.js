'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

let selectionSegments = {};
try {
  selectionSegments = require('../scripts/lib/selection_segments');
} catch (_) {
  // RED 阶段模块尚不存在；行为断言会指出缺少公开函数。
}

test('恢复的空白会切断两侧删除段并重新进入播放', () => {
  assert.equal(typeof selectionSegments.selectedIndicesToSegments, 'function');

  const words = [
    { text: '前', start: 0, end: 0.2, isGap: false },
    { text: '', start: 0.2, end: 0.5, isGap: true },
    { text: '后', start: 0.5, end: 0.7, isGap: false },
  ];

  assert.deepEqual(
    selectionSegments.selectedIndicesToSegments(words, [0, 2]),
    [
      { start: 0, end: 0.2 },
      { start: 0.5, end: 0.7 },
    ],
  );
});

test('连续选中的词和空白仍合并为一段删除区间', () => {
  const words = [
    { text: '前', start: 0, end: 0.2, isGap: false },
    { text: '', start: 0.2, end: 0.5, isGap: true },
    { text: '后', start: 0.5, end: 0.7, isGap: false },
  ];

  assert.deepEqual(
    selectionSegments.selectedIndicesToSegments(words, [0, 1, 2]),
    [{ start: 0, end: 0.7 }],
  );
});

test('波形显示与播放预览共用恢复内容保护参数', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../scripts/templates/review.html'),
    'utf8',
  );
  const computeCalls = html.match(/ComputeKeeps\.computeFinalKeeps\(/g) || [];
  const protectedOptsCalls = html.match(/getProtectedCutOpts\(\)/g) || [];

  assert.equal(computeCalls.length, 2, '工作台应只有波形与播放两处切割计算');
  assert.equal(protectedOptsCalls.length, 3, '保护参数应定义一次，并由波形与播放各调用一次');
});
