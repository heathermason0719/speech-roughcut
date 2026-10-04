'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createEditState } = require('./edit_state');
const { compileEdit, validateCompiledCutPlan } = require('./compile_edit');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function buildEditSnapshot({ reviewData, detectedSilence, mediaContext, editState, compiledCutPlan, includeTitles }) {
  validateCompiledCutPlan(compiledCutPlan);
  let state = null;
  if (editState !== undefined) {
    if (!editState || !editState.policy?.version) throw new Error('编辑快照需要明确策略版本');
    state = createEditState(editState);
    const initial = [...new Set(reviewData.initialSuggestedWordDeletes)].sort();
    if (!isDeepStrictEqual(state.initialSuggestedWordDeletes, initial)) throw new Error('editState 的 AI 初选与冻结输入不一致');
    const known = new Set(reviewData.words.map(word => word.id));
    for (const id of [...state.currentDeletedWordIds, ...state.explicitlyRestoredWordIds]) {
      if (!known.has(id)) throw new Error(`editState 引用未知 word: ${id}`);
    }
  }
  const inputs = clone({
    words: reviewData.words, asrBreaks: reviewData.asrBreaks || [], mediaContext,
    // Keep all frozen evidence in plan-only exports; a full snapshot records the exact compiler input.
    detectedSilence: state ? detectedSilence.filter(item => Number(item.thresholdDb) === Number(state.policy.silenceThresholdDb)) : detectedSilence,
    ...(reviewData.audioSuggestions ? { audioSuggestions: reviewData.audioSuggestions } : {}),
  });
  if (state && !isDeepStrictEqual(compileEdit({ ...inputs, editState: state }), compiledCutPlan)) {
    throw new Error('editState 重放与 compiledCutPlan 不一致，未导出');
  }
  return {
    format: 'speech-roughcut-edit-snapshot', formatVersion: 1,
    completeness: state ? 'complete' : 'plan-only',
    policyVersion: state?.policy.version || null,
    createdAt: new Date().toISOString(),
    inputs, inputHash: digest(inputs), editState: state,
    compiledCutPlan: clone(compiledCutPlan), includeTitles: includeTitles !== false,
  };
}

function replayEditSnapshot(snapshot) {
  if (snapshot?.format !== 'speech-roughcut-edit-snapshot' || snapshot.formatVersion !== 1) throw new Error('编辑快照格式无效');
  if (snapshot.completeness !== 'complete' || !snapshot.editState) throw new Error('此快照缺少完整编辑状态，不能重放决定');
  if (digest(snapshot.inputs) !== snapshot.inputHash) throw new Error('编辑快照输入 hash 不一致');
  const state = createEditState(snapshot.editState);
  if (snapshot.policyVersion !== state.policy.version) throw new Error('快照策略版本不一致');
  const plan = compileEdit({ ...snapshot.inputs, editState: state });
  if (!isDeepStrictEqual(plan, snapshot.compiledCutPlan)) throw new Error('快照重放计划不一致');
  return plan;
}

module.exports = { buildEditSnapshot, replayEditSnapshot };
