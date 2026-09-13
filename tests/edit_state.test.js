'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let edit = {};
try {
  edit = require('../scripts/lib/edit_state');
} catch (_) {
  // RED: editState 合同尚未实现。
}

test('普通未删除词不能伪装成明确恢复，真实恢复与撤销恢复可区分', () => {
  assert.equal(typeof edit.createEditState, 'function');
  const initial = edit.createEditState({ initialSuggestedWordDeletes: ['w2'] });
  const untouched = edit.transitionEditState(initial, { type: 'RESTORE_WORD', wordId: 'w1' });
  assert.deepEqual(untouched.explicitlyRestoredWordIds, []);

  const restored = edit.transitionEditState(initial, { type: 'RESTORE_WORD', wordId: 'w2' });
  assert.deepEqual(restored.currentDeletedWordIds, []);
  assert.deepEqual(restored.explicitlyRestoredWordIds, ['w2']);

  const undone = edit.transitionEditState(restored, { type: 'UNDO_RESTORE_WORD', wordId: 'w2' });
  assert.deepEqual(undone.currentDeletedWordIds, ['w2']);
  assert.deepEqual(undone.explicitlyRestoredWordIds, []);
});

test('静音只有确实生效后恢复才形成保护，人工范围保持独立', () => {
  const initial = edit.createEditState();
  const ignored = edit.transitionEditState(initial, {
    type: 'RESTORE_SILENCE', silenceId: 's1',
    range: { startSample: 100, endSample: 200 }, wasEffective: false,
  });
  assert.deepEqual(ignored.explicitlyRestoredSilenceIds, []);
  assert.deepEqual(ignored.explicitlyRestoredSilenceRanges, []);

  const restored = edit.transitionEditState(initial, {
    type: 'RESTORE_SILENCE', silenceId: 's1',
    range: { startSample: 100, endSample: 200 }, wasEffective: true,
  });
  const withRange = edit.transitionEditState(restored, {
    type: 'ADD_MANUAL_DELETE_RANGE', range: { startSample: 100, endSample: 200 },
  });
  assert.deepEqual(withRange.explicitlyRestoredSilenceIds, ['s1']);
  assert.deepEqual(withRange.explicitlyRestoredSilenceRanges, [
    { silenceId: 's1', startSample: 100, endSample: 200 },
  ]);
  assert.deepEqual(withRange.manualDeleteRanges, [{ startSample: 100, endSample: 200 }]);

  const undone = edit.transitionEditState(withRange, {
    type: 'UNDO_RESTORE_SILENCE', silenceId: 's2',
    range: { startSample: 50, endSample: 150 },
  });
  assert.deepEqual(undone.explicitlyRestoredSilenceRanges, withRange.explicitlyRestoredSilenceRanges);
  const exactUndo = edit.transitionEditState(undone, {
    type: 'UNDO_RESTORE_SILENCE', silenceId: 's1',
    range: { startSample: 100, endSample: 200 },
  });
  assert.deepEqual(exactUndo.explicitlyRestoredSilenceRanges, []);
});

test('手动删除范围可按同一整数 sample 边界移除且不影响其他范围', () => {
  const initial = edit.createEditState({
    manualDeleteRanges: [
      { startSample: 100, endSample: 200 },
      { startSample: 300, endSample: 400 },
    ],
  });

  const removed = edit.transitionEditState(initial, {
    type: 'REMOVE_MANUAL_DELETE_RANGE',
    range: { startSample: 100, endSample: 200 },
  });

  assert.deepEqual(removed.manualDeleteRanges, [
    { startSample: 300, endSample: 400 },
  ]);
});
