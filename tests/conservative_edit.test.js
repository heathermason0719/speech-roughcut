'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createEditState, transitionEditState } = require('../scripts/lib/edit_state');
const { compileEdit } = require('../scripts/lib/compile_edit');

const words = [
  { id: 'a', text: '前', startSample: 100, endSample: 200 },
  { id: 'b', text: '重', startSample: 300, endSample: 400 },
  { id: 'c', text: '说', startSample: 500, endSample: 600 },
  { id: 'd', text: '后', startSample: 700, endSample: 800 },
];
const mediaContext = {
  review: { sampleRate: 48000, decodedSampleCount: 1000 },
  timebase: { kind: 'audio-samples', ticksPerSecond: 48000 },
  offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } },
};
const state = options => createEditState({ ...options, policy: {
  ...options?.policy, version: 'conservative-v1',
} });
const compile = (editState, inputWords = words) => compileEdit({
  words: inputWords, asrBreaks: [], mediaContext, editState,
  detectedSilence: [{ id: 'pcm', startSample: 0, endSample: 1000, energy: { maxDb: -80 } }],
});
const cuts = plan => plan.cuts.map(c => [c.reviewStartSample, c.reviewEndSample]);

test('保守策略不因 PCM、padding、合并参数或短 keep 丢失未选声音', () => {
  const policy = { autoSilenceEnabled: true, minimumSilenceSamples: 1,
    silencePaddingStartSamples: 20, silencePaddingEndSamples: 30,
    mergeGapSamples: 1000, minimumKeepSamples: 1000 };
  assert.deepEqual(cuts(compile(state({ policy }))), []);
  assert.deepEqual(cuts(compile(state({ policy, currentDeletedWordIds: ['b'] }))), [[300, 400]]);
});

test('连续删词只覆盖首末词和内部间隙，文件头尾及外围间隙保留', () => {
  for (const [ids, expected] of [
    [['a'], [[100, 200]]], [['d'], [[700, 800]]],
    [['b', 'c'], [[300, 600]]], [['a', 'd'], [[100, 200], [700, 800]]],
  ]) assert.deepEqual(cuts(compile(state({ currentDeletedWordIds: ids }))), expected);
});

test('保留词时间保护仅约束词级删除，独立音频删除仍生效', () => {
  const overlapWords = [words[0], words[1], { ...words[2], startSample: 380 }];
  let s = state({ currentDeletedWordIds: ['b'], explicitlyRestoredWordIds: ['c'] });
  assert.deepEqual(cuts(compile(s, overlapWords)), [[300, 380]]);
  s = transitionEditState(s, { type: 'ADD_MANUAL_DELETE_RANGE', range: { id: 'sound-a', startSample: 370, endSample: 520 } });
  assert.deepEqual(cuts(compile(s, overlapWords)), [[300, 520]]);
  assert.deepEqual(compile(s, overlapWords).wordDecisions.finalDeletedWordIds, ['b']);
});

test('手工范围通过 ID 独立取消，包含完全相同的重叠区间', () => {
  let s = state();
  for (const id of ['sound-a', 'sound-b']) s = transitionEditState(s, {
    type: 'ADD_MANUAL_DELETE_RANGE', range: { id, startSample: 210, endSample: 290 },
  });
  s = transitionEditState(s, { type: 'REMOVE_MANUAL_DELETE_RANGE', id: 'sound-a' });
  assert.deepEqual(s.manualDeleteRanges, [{ id: 'sound-b', startSample: 210, endSample: 290 }]);
  assert.deepEqual(cuts(compile(s)), [[210, 290]]);
  const restored = transitionEditState(s, { type: 'REMOVE_MANUAL_DELETE_RANGE', id: 'sound-b' });
  assert.deepEqual(cuts(compile(restored)), []);
});

test('保守范围越界、空范围、重复 ID 和未知策略明确拒绝', () => {
  for (const [startSample, endSample] of [[-1, 20], [900, 1001], [20, 20]]) {
    assert.throws(() => compile(state({ manualDeleteRanges: [{ id: 'bad', startSample, endSample }] })), /范围|sample/);
  }
  assert.throws(() => state({ manualDeleteRanges: [
    { id: 'same', startSample: 10, endSample: 20 }, { id: 'same', startSample: 30, endSample: 40 },
  ] }), /重复/);
  assert.throws(() => createEditState({ policy: { version: 'unknown' } }), /策略/);
});

test('未带版本的历史状态继续按旧规则复现，不静默改成保守策略', () => {
  assert.deepEqual(cuts(compile(createEditState({
    currentDeletedWordIds: ['b'], policy: { autoSilenceEnabled: false },
  }))), [[200, 500]]);
});
