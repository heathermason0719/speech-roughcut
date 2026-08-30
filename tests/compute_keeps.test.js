'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeFinalKeeps } = require('../scripts/lib/compute_keeps');

test('静音二次切割不会吞掉用户明确恢复的空白或文字', () => {
  const keeps = computeFinalKeeps(
    [
      { start: 0, end: 0.5 },
      { start: 2, end: 2.5 },
    ],
    [
      { start: 1, end: 1.5 },
      { start: 1.55, end: 1.75 },
    ],
    4,
    {
      lookBack: 0,
      padStart: 0,
      padEnd: 0,
      minKeepDur: 0.01,
      minInternalSilence: 0.2,
      protectedSegments: [
        { start: 1, end: 1.5 },
        { start: 1.6, end: 1.8 },
      ],
    },
  );

  assert.deepEqual(keeps, [
    { start: 0.5, end: 2 },
    { start: 2.5, end: 4 },
  ]);
});

test('短于合并阈值的恢复词仍会阻止两侧删除段合并', () => {
  const keeps = computeFinalKeeps(
    [
      { start: 0, end: 0.5 },
      { start: 0.6, end: 1 },
    ],
    [],
    1,
    {
      mergeGap: 0.15,
      minKeepDur: 0.01,
      lookBack: 0,
      minInternalSilence: 99,
      protectedSegments: [{ start: 0.5, end: 0.6 }],
    },
  );

  assert.deepEqual(keeps, [{ start: 0.5, end: 0.6 }]);
});

test('边界吸附不能越过恢复项使用后方静音', () => {
  const keeps = computeFinalKeeps(
    [
      { start: 0, end: 0.5 },
      { start: 0.9, end: 1.2 },
    ],
    [{ start: 0.95, end: 1.1 }],
    1.5,
    {
      mergeGap: 0.15,
      minKeepDur: 0.1,
      lookBack: 0.6,
      padStart: 0,
      padEnd: 0,
      minInternalSilence: 0.2,
      protectedSegments: [{ start: 0.5, end: 0.9 }],
    },
  );

  assert.deepEqual(keeps, [
    { start: 0.5, end: 0.9 },
    { start: 1.2, end: 1.5 },
  ]);
});
