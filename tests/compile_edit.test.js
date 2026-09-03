'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let compiler = {};
let edit = {};
try {
  compiler = require('../scripts/lib/compile_edit');
  edit = require('../scripts/lib/edit_state');
} catch (_) {
  // RED: 唯一编译核心尚未实现。
}

function mediaContext({
  reviewSamples = 48000,
  sourceSampleRate = 44100,
  timebase,
  sourceOffset = 0,
  sourceOffsetStatus = 'verified',
} = {}) {
  return {
    review: { sampleRate: 48000, decodedSampleCount: reviewSamples },
    source: { sampleRate: sourceSampleRate, rate: 1 },
    timebase: timebase || { kind: 'audio-samples', ticksPerSecond: sourceSampleRate },
    offsets: {
      sourceMediaOffset: { seconds: sourceOffset, status: sourceOffsetStatus },
    },
  };
}

function wordsFixture() {
  return [
    { id: 'w1', text: '开头', startSample: 0, endSample: 9000 },
    { id: 'w2', text: '删除', startSample: 9600, endSample: 19200 },
    { id: 'w3', text: 'FinalCut', startSample: 24000, endSample: 33600 },
    { id: 'w4', text: '结尾', startSample: 33600, endSample: 43200 },
  ];
}

function assertPlanTopology(plan) {
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const keep of plan.keeps) {
    assert.equal(Number.isInteger(keep.sourceStartTick), true);
    assert.equal(Number.isInteger(keep.sourceEndTick), true);
    assert.equal(Number.isInteger(keep.outputStartTick), true);
    assert.equal(Number.isInteger(keep.outputEndTick), true);
    assert.ok(keep.sourceStartTick >= sourceCursor);
    assert.equal(keep.outputStartTick, outputCursor);
    sourceCursor = keep.sourceEndTick;
    outputCursor = keep.outputEndTick;
  }
  const coverage = [...plan.keeps.map(item => ({ type: 'keep', start: item.sourceStartTick, end: item.sourceEndTick })),
    ...plan.cuts.map(item => ({ type: 'cut', start: item.sourceStartTick, end: item.sourceEndTick }))]
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  for (const item of coverage) {
    assert.equal(item.start, cursor);
    cursor = item.end;
  }
  assert.equal(cursor, plan.sourceDurationTicks);
}

test('同一 editState 确定性地产生唯一整数 plan，音频边界误差不超过一个源 sample', () => {
  assert.equal(typeof compiler.compileEdit, 'function');
  const state = edit.createEditState({
    initialSuggestedWordDeletes: ['w2'],
    policy: { silenceThresholdDb: -35, minimumSilenceSamples: 1000 },
  });
  const input = {
    words: wordsFixture(),
    asrBreaks: [{ id: 'b1', startSample: 19200, endSample: 24000, previousWordId: 'w2', nextWordId: 'w3' }],
    detectedSilence: [{
      id: 's1', startSample: 19200, endSample: 24000,
      energy: { maxDb: -60, meanDb: -70 }, thresholdDb: -35, candidateSource: 'global',
    }],
    editState: state,
    mediaContext: mediaContext(),
  };
  const first = compiler.compileEdit(input);
  const second = compiler.compileEdit(input);

  assert.deepEqual(first, second);
  assertPlanTopology(first);
  assert.deepEqual(first.retainedWordIds, ['w1', 'w3', 'w4']);
  assert.deepEqual(first.wordDecisions, {
    initialSuggestedWordDeleteIds: ['w2'],
    finalDeletedWordIds: ['w2'],
  });
  assert.ok(Math.abs(first.keeps[0].sourceEndTick / 44100 - 9000 / 48000) <= 1 / 44100);
  assert.ok(Math.abs(first.keeps[1].sourceStartTick / 44100 - 24000 / 48000) <= 1 / 44100);
  for (const keep of first.keeps) {
    const startSeconds = keep.sourceStartTick / 44100;
    const endSeconds = keep.sourceEndTick / 44100;
    assert.ok(Math.abs(startSeconds - keep.reviewStartSample / 48000) <= 1 / 44100);
    assert.ok(Math.abs(endSeconds - keep.reviewEndSample / 48000) <= 1 / 44100);
  }
  for (const title of first.titleBlocks) {
    const keep = first.keeps[title.keepIndex];
    assert.ok(title.outputStartTick >= keep.outputStartTick);
    assert.ok(title.outputEndTick <= keep.outputEndTick);
    assert.ok(title.reviewStartSample >= keep.reviewStartSample);
    assert.ok(title.reviewEndSample <= keep.reviewEndSample);
    assert.doesNotMatch(title.text, /删除/);
  }
});

test('连续删除词贯穿内部空隙，遇到恢复词立即断开', () => {
  const words = [
    { id: 'w1', text: '保留', startSample: 0, endSample: 1000 },
    { id: 'w2', text: '删除甲', startSample: 2000, endSample: 3000 },
    { id: 'w3', text: '删除乙', startSample: 8000, endSample: 9000 },
    { id: 'w4', text: '恢复', startSample: 12000, endSample: 13000 },
    { id: 'w5', text: '删除丙', startSample: 16000, endSample: 17000 },
    { id: 'w6', text: '删除丁', startSample: 22000, endSample: 23000 },
    { id: 'w7', text: '保留', startSample: 24000, endSample: 25000 },
  ];
  const initiallyDeleted = edit.createEditState({
    initialSuggestedWordDeletes: ['w2', 'w3', 'w4', 'w5', 'w6'],
  });
  const restoredMiddle = edit.transitionEditState(initiallyDeleted, {
    type: 'RESTORE_WORD',
    wordId: 'w4',
  });

  const plan = compiler.compileEdit({
    words,
    asrBreaks: [
      { id: 'b1', startSample: 3000, endSample: 8000, previousWordId: 'w2', nextWordId: 'w3' },
      { id: 'b2', startSample: 17000, endSample: 22000, previousWordId: 'w5', nextWordId: 'w6' },
    ],
    detectedSilence: [],
    editState: restoredMiddle,
    mediaContext: mediaContext({
      reviewSamples: 30000,
      sourceSampleRate: 48000,
    }),
  });

  assert.deepEqual(
    plan.cuts.map(cut => [cut.reviewStartSample, cut.reviewEndSample]),
    [[1000, 12000], [13000, 24000]],
  );
  assert.equal(plan.cuts.some(cut => (
    cut.reviewStartSample < 13000 && cut.reviewEndSample > 12000
  )), false);
  assert.deepEqual(plan.retainedWordIds, ['w1', 'w4', 'w7']);
});

test('删除 run 的外边界只在相邻保留词一侧留下配置的安全帧', () => {
  const words = [
    { id: 'w1', text: '前句', startSample: 1000, endSample: 3000 },
    { id: 'w2', text: '删除甲', startSample: 10000, endSample: 12000 },
    { id: 'w3', text: '删除乙', startSample: 20000, endSample: 22000 },
    { id: 'w4', text: '后句', startSample: 30000, endSample: 32000 },
  ];
  const state = edit.createEditState({
    initialSuggestedWordDeletes: ['w2', 'w3'],
    policy: {
      autoSilenceEnabled: false,
      silencePaddingStartSamples: 2400,
      silencePaddingEndSamples: 4800,
    },
  });

  const plan = compiler.compileEdit({
    words,
    asrBreaks: [
      { id: 'before', startSample: 3000, endSample: 10000, previousWordId: 'w1', nextWordId: 'w2' },
      { id: 'inside', startSample: 12000, endSample: 20000, previousWordId: 'w2', nextWordId: 'w3' },
      { id: 'after', startSample: 22000, endSample: 30000, previousWordId: 'w3', nextWordId: 'w4' },
    ],
    detectedSilence: [],
    editState: state,
    mediaContext: mediaContext({
      reviewSamples: 40000,
      sourceSampleRate: 48000,
    }),
  });

  assert.deepEqual(
    plan.cuts.map(cut => [cut.reviewStartSample, cut.reviewEndSample]),
    [[7800, 27600]],
  );
  assert.deepEqual(plan.retainedWordIds, ['w1', 'w4']);
});

test('普通未删除内容不保护静音；明确恢复词、恢复静音与撤销恢复结果不同', () => {
  const context = mediaContext();
  const words = [{ id: 'w1', text: '内容', startSample: 10000, endSample: 20000 }];
  const silence = [{
    id: 's1', startSample: 12000, endSample: 18000,
    energy: { maxDb: -60, meanDb: -70 }, thresholdDb: -35, candidateSource: 'global',
  }];
  const ordinary = compiler.compileEdit({
    words, asrBreaks: [], detectedSilence: silence,
    editState: edit.createEditState({ policy: { minimumSilenceSamples: 1 } }),
    mediaContext: context,
  });
  assert.ok(ordinary.cuts.length > 0);

  const deleted = edit.createEditState({
    initialSuggestedWordDeletes: ['w1'], policy: { minimumSilenceSamples: 1 },
  });
  const restoredState = edit.transitionEditState(deleted, { type: 'RESTORE_WORD', wordId: 'w1' });
  const restored = compiler.compileEdit({
    words, asrBreaks: [], detectedSilence: silence,
    editState: restoredState, mediaContext: context,
  });
  assert.equal(restored.cuts.length, 0);

  const undoneState = edit.transitionEditState(restoredState, { type: 'UNDO_RESTORE_WORD', wordId: 'w1' });
  const undone = compiler.compileEdit({
    words, asrBreaks: [], detectedSilence: silence,
    editState: undoneState, mediaContext: context,
  });
  assert.ok(undone.cuts.length > 0);

  const restoredSilenceState = edit.transitionEditState(edit.createEditState({ policy: { minimumSilenceSamples: 1 } }), {
    type: 'RESTORE_SILENCE', silenceId: 's1',
    range: { startSample: 12000, endSample: 18000 }, wasEffective: true,
  });
  const restoredSilence = compiler.compileEdit({
    words, asrBreaks: [], detectedSilence: silence,
    editState: restoredSilenceState, mediaContext: context,
  });
  assert.equal(restoredSilence.cuts.length, 0);

  const changedThresholdCandidate = [{
    ...silence[0], id: 'silence-m30-10000-20000',
    startSample: 10000, endSample: 20000, thresholdDb: -30,
  }];
  const changedThresholdState = edit.transitionEditState(restoredSilenceState, {
    type: 'SET_POLICY', patch: { silenceThresholdDb: -30 },
  });
  const afterThresholdChange = compiler.compileEdit({
    words, asrBreaks: [], detectedSilence: changedThresholdCandidate,
    editState: changedThresholdState, mediaContext: context,
  });
  assert.equal(
    afterThresholdChange.cuts.some(cut => (
      cut.reviewStartSample <= 15000 && cut.reviewEndSample > 15000
    )),
    false,
  );
});

test('只改变 ASR break 不能产生没有 PCM 证据的新 cut', () => {
  const base = {
    words: wordsFixture(),
    detectedSilence: [],
    editState: edit.createEditState(),
    mediaContext: mediaContext(),
  };
  const withoutBreak = compiler.compileEdit({ ...base, asrBreaks: [] });
  const withBreak = compiler.compileEdit({
    ...base,
    asrBreaks: [{ id: 'b', startSample: 9000, endSample: 30000, previousWordId: 'w1', nextWordId: 'w4' }],
  });
  assert.deepEqual(withBreak.keeps, withoutBreak.keeps);
  assert.deepEqual(withBreak.cuts, withoutBreak.cuts);
});

test('静音阈值只筛选 PCM 举证候选，缺失能量证据时 fail closed', () => {
  const silence = [{
    id: 's1', startSample: 10000, endSample: 20000,
    energy: { maxDb: -40, meanDb: -45 }, thresholdDb: -35, candidateSource: 'global',
  }];
  const compileAt = silenceThresholdDb => compiler.compileEdit({
    words: [], asrBreaks: [], detectedSilence: silence,
    editState: edit.createEditState({ policy: { silenceThresholdDb, minimumSilenceSamples: 1 } }),
    mediaContext: mediaContext(),
  });
  assert.equal(compileAt(-50).cuts.length, 0);
  assert.ok(compileAt(-30).cuts.length > 0);
  assert.throws(() => compiler.compileEdit({
    words: [], asrBreaks: [],
    detectedSilence: [{ id: 'bad', startSample: 100, endSample: 200 }],
    editState: edit.createEditState({ policy: { minimumSilenceSamples: 1 } }),
    mediaContext: mediaContext(),
  }), /缺少 PCM 证据/);
});

test('CFR 视频边界落在 frame grid，保留内容语义扩张不超过一帧', () => {
  const context = mediaContext({
    reviewSamples: 96000,
    timebase: { kind: 'video-frames', fpsNum: 30000, fpsDen: 1001 },
  });
  const state = edit.createEditState();
  const withManual = edit.transitionEditState(state, {
    type: 'ADD_MANUAL_DELETE_RANGE',
    range: { startSample: 24001, endSample: 47999 },
  });
  const plan = compiler.compileEdit({
    words: [], asrBreaks: [], detectedSilence: [], editState: withManual, mediaContext: context,
  });

  assertPlanTopology(plan);
  assert.equal(plan.sourceDurationTicks, 60);
  const frameSeconds = 1001 / 30000;
  for (const keep of plan.keeps) {
    const sourceStart = keep.sourceStartTick * frameSeconds;
    const sourceEnd = keep.sourceEndTick * frameSeconds;
    assert.ok(keep.reviewStartSample / 48000 - sourceStart <= frameSeconds);
    assert.ok(sourceEnd - keep.reviewEndSample / 48000 <= frameSeconds);
  }
  const frameSamples = frameSeconds * 48000;
  assert.ok(Math.abs(plan.keeps[0].reviewEndSample - 24001) <= frameSamples);
  assert.ok(Math.abs(plan.keeps[1].reviewStartSample - 47999) <= frameSamples);
});

test('timebase 非法或 sourceMediaOffset 未验证时 fail closed', () => {
  const input = {
    words: [], asrBreaks: [], detectedSilence: [], editState: edit.createEditState(),
  };
  assert.throws(() => compiler.compileEdit({
    ...input,
    mediaContext: mediaContext({ timebase: { kind: 'video-frames', fpsNum: 0, fpsDen: 1 } }),
  }), /timebase/);
  assert.throws(() => compiler.compileEdit({
    ...input,
    mediaContext: mediaContext({ sourceOffsetStatus: 'pending' }),
  }), /sourceMediaOffset.*未验证/);
});
