'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ReviewWorkbench } = require('../scripts/lib/review_workbench');

test('导航按真实时间连通，跨词仅合并导航区域并保全每条证据', () => {
  const words = [
    { id: 'a', startSample: 0, endSample: 100 },
    { id: 'b', startSample: 1000, endSample: 1100 },
    { id: 'c', startSample: 2000, endSample: 2100 },
  ];
  const asrBreaks = [
    { id: 'asr-a', previousWordId: 'a', nextWordId: 'b', startSample: 100, endSample: 1000 },
    { id: 'asr-b', previousWordId: 'b', nextWordId: 'c', startSample: 1100, endSample: 2000 },
  ];
  const detectedSilence = [
    { id: 'pcm-a', startSample: 200, endSample: 700 },
    { id: 'pcm-cross-word', startSample: 800, endSample: 1200 },
    { id: 'pcm-touch', startSample: 2100, endSample: 2300 },
    { id: 'pcm-touch-2', startSample: 2300, endSample: 2500 },
    { id: 'pcm-disjoint', startSample: 2600, endSample: 2900 },
  ];
  const input = { words, asrBreaks, detectedSilence };
  const before = JSON.stringify(input);
  assert.equal(typeof ReviewWorkbench.buildPauseGroups, 'function', 'presentation must group evidence without modifying it');
  const groups = ReviewWorkbench.buildPauseGroups(input);
  assert.deepEqual(groups.map(group => [group.startSample, group.endSample, group.evidence.map(e => e.item.id)]), [
    [100, 2000, ['asr-a', 'pcm-a', 'pcm-cross-word', 'asr-b']],
    [2100, 2500, ['pcm-touch', 'pcm-touch-2']],
    [2600, 2900, ['pcm-disjoint']],
  ]);
  assert.equal(JSON.stringify(input), before);
});
