'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState, transitionEditState } = require('../scripts/lib/edit_state');

function mediaContext() {
  return {
    review: { sampleRate: 48000, decodedSampleCount: 600 },
    timebase: { kind: 'audio-samples', ticksPerSecond: 48000 },
    offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } },
  };
}

function pcm(id, startSample, endSample) {
  return {
    id,
    startSample,
    endSample,
    energy: { maxDb: -60, meanDb: -70 },
  };
}

function cutsSample(plan, sample) {
  return plan.cuts.some(cut => (
    cut.reviewStartSample <= sample && cut.reviewEndSample > sample
  ));
}

test('PCM 恢复只撤销自动 PCM 删除，保留重叠的词和独立手工删除', () => {
  const words = [
    { id: 'before', text: '前', startSample: 0, endSample: 100 },
    { id: 'deleted', text: '删', startSample: 200, endSample: 300 },
    { id: 'after', text: '后', startSample: 400, endSample: 500 },
  ];
  const restored = transitionEditState(createEditState({
    initialSuggestedWordDeletes: ['deleted'],
    manualDeleteRanges: [{ startSample: 220, endSample: 280 }],
    policy: { minimumSilenceSamples: 1 },
  }), {
    type: 'RESTORE_SILENCE',
    silenceId: 'pcm-a',
    range: { startSample: 220, endSample: 280 },
    wasEffective: true,
  });

  const plan = compileEdit({
    words,
    asrBreaks: [],
    detectedSilence: [pcm('pcm-a', 220, 280)],
    editState: restored,
    mediaContext: mediaContext(),
  });

  assert.equal(cutsSample(plan, 250), true);
  assert.deepEqual(plan.retainedWordIds, ['before', 'after']);
  assert.equal(plan.titleBlocks.some(block => block.wordIds.includes('deleted')), false);
});

test('PCM 恢复范围跨阈值候选重算仍只保留原恢复区间', () => {
  const restored = transitionEditState(createEditState({
    policy: { minimumSilenceSamples: 1, silenceThresholdDb: -35 },
  }), {
    type: 'RESTORE_SILENCE',
    silenceId: 'pcm-m35',
    range: { startSample: 220, endSample: 280 },
    wasEffective: true,
  });
  const changedThreshold = transitionEditState(restored, {
    type: 'SET_POLICY', patch: { silenceThresholdDb: -30 },
  });

  const plan = compileEdit({
    words: [],
    asrBreaks: [],
    detectedSilence: [pcm('pcm-m30', 200, 300)],
    editState: changedThreshold,
    mediaContext: mediaContext(),
  });

  assert.equal(cutsSample(plan, 210), true);
  assert.equal(cutsSample(plan, 250), false);
  assert.equal(cutsSample(plan, 290), true);
});

test('先删内容或先恢复 PCM 得到同一事实，撤销 PCM 恢复仍保留内容删除', () => {
  const words = [
    { id: 'before', text: '前', startSample: 0, endSample: 100 },
    { id: 'deleted', text: '删', startSample: 200, endSample: 300 },
    { id: 'after', text: '后', startSample: 400, endSample: 500 },
  ];
  const initial = createEditState({ policy: { minimumSilenceSamples: 1 } });
  const deletion = { type: 'DELETE_WORD', wordId: 'deleted' };
  const restoration = {
    type: 'RESTORE_SILENCE', silenceId: 'pcm-a',
    range: { startSample: 220, endSample: 280 }, wasEffective: true,
  };
  const apply = actions => actions.reduce(transitionEditState, initial);
  const compile = editState => compileEdit({
    words, asrBreaks: [], detectedSilence: [pcm('pcm-a', 220, 280)],
    editState, mediaContext: mediaContext(),
  });
  const first = apply([deletion, restoration]);
  const second = apply([restoration, deletion]);
  assert.deepEqual(compile(first), compile(second));
  assert.equal(cutsSample(compile(first), 250), true);
  assert.equal(compile(first).titleBlocks.some(block => block.wordIds.includes('deleted')), false);
  const undone = transitionEditState(first, { ...restoration, type: 'UNDO_RESTORE_SILENCE' });
  assert.deepEqual(undone.currentDeletedWordIds, ['deleted']);
  assert.deepEqual(undone.explicitlyRestoredSilenceRanges, []);
  assert.equal(cutsSample(compile(undone), 250), true);
});

test('PCM 来源手工删除可单独撤销，普通手工删除保持独立', () => {
  const initial = createEditState({
    manualDeleteRanges: [{ startSample: 220, endSample: 280 }],
  });
  const withPcmMark = transitionEditState(initial, {
    type: 'ADD_MANUAL_DELETE_RANGE',
    range: { startSample: 220, endSample: 280 },
    sourceSilenceId: 'pcm-a',
  });
  const removedPcmMark = transitionEditState(withPcmMark, {
    type: 'REMOVE_MANUAL_DELETE_RANGE',
    range: { startSample: 220, endSample: 280 },
    sourceSilenceId: 'pcm-a',
  });

  assert.deepEqual(withPcmMark.manualDeleteRanges, [
    { startSample: 220, endSample: 280 },
    { startSample: 220, endSample: 280, sourceSilenceId: 'pcm-a' },
  ]);
  assert.deepEqual(removedPcmMark.manualDeleteRanges, [
    { startSample: 220, endSample: 280 },
  ]);
});

test('撤销一个 PCM 恢复不会撤销重叠的另一条恢复', () => {
  const first = transitionEditState(createEditState(), {
    type: 'RESTORE_SILENCE', silenceId: 'pcm-a',
    range: { startSample: 200, endSample: 250 }, wasEffective: true,
  });
  const both = transitionEditState(first, {
    type: 'RESTORE_SILENCE', silenceId: 'pcm-b',
    range: { startSample: 240, endSample: 290 }, wasEffective: true,
  });
  const undone = transitionEditState(both, {
    type: 'UNDO_RESTORE_SILENCE', silenceId: 'pcm-a',
    range: { startSample: 200, endSample: 250 },
  });

  assert.deepEqual(undone.explicitlyRestoredSilenceRanges, [
    { silenceId: 'pcm-b', startSample: 240, endSample: 290 },
  ]);
  assert.deepEqual(undone.explicitlyRestoredSilenceIds, ['pcm-b']);
});
