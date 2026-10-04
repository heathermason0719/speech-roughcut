(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_POLICY = Object.freeze({
    version: 'legacy-v1',
    autoSilenceEnabled: true,
    silenceThresholdDb: -35,
    minimumSilenceSamples: 9600,
    silencePaddingStartSamples: 0,
    silencePaddingEndSamples: 0,
    mergeGapSamples: 0,
    minimumKeepSamples: 1,
    titleMaxVisualWidth: 14,
  });

  function uniqueSorted(values) {
    return [...new Set((values || []).map(String))].sort();
  }

  function normalizeRanges(ranges) {
    return (ranges || []).map(range => {
      const startSample = Number(range.startSample);
      const endSample = Number(range.endSample);
      if (!Number.isInteger(startSample) || !Number.isInteger(endSample) || endSample <= startSample) {
        throw new Error('manualDeleteRanges 必须使用有效整数 sample 边界');
      }
      return {
        ...(range.id == null ? {} : { id: String(range.id) }),
        ...(range.sourceSilenceId == null ? {} : { sourceSilenceId: String(range.sourceSilenceId) }),
        startSample,
        endSample,
      };
    }).sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);
  }

  function normalizeSilenceRanges(ranges) {
    return (ranges || []).map(range => {
      const normalized = normalizeRanges([range])[0];
      return {
        ...(range.silenceId == null ? {} : { silenceId: String(range.silenceId) }),
        startSample: normalized.startSample,
        endSample: normalized.endSample,
      };
    }).sort((left, right) => left.startSample - right.startSample
      || left.endSample - right.endSample
      || String(left.silenceId || '').localeCompare(String(right.silenceId || '')));
  }

  function createEditState(options = {}) {
    const policy = Object.assign({}, DEFAULT_POLICY, options.policy || {});
    if (!['legacy-v1', 'conservative-v1', 'narration-v1'].includes(policy.version)) throw new Error('未知编辑策略');
    if (policy.version !== 'legacy-v1') Object.assign(policy, {
      autoSilenceEnabled: false, silencePaddingStartSamples: 0, silencePaddingEndSamples: 0,
      mergeGapSamples: 0, minimumKeepSamples: 1,
    });
    const manualDeleteRanges = normalizeRanges(options.manualDeleteRanges);
    const rangeIds = new Set();
    for (const range of manualDeleteRanges) {
      if (policy.version !== 'legacy-v1' && !range.id) throw new Error('音频范围缺少 ID');
      if (range.id != null) {
        if (!range.id || rangeIds.has(range.id)) throw new Error('音频范围 ID 为空或重复');
        rangeIds.add(range.id);
      }
    }
    const initial = uniqueSorted(options.initialSuggestedWordDeletes);
    const current = options.currentDeletedWordIds === undefined
      ? initial.slice()
      : uniqueSorted(options.currentDeletedWordIds);
    return {
      initialSuggestedWordDeletes: initial,
      currentDeletedWordIds: current,
      manualDeleteRanges,
      explicitlyRestoredWordIds: uniqueSorted(options.explicitlyRestoredWordIds),
      explicitlyRestoredSilenceIds: uniqueSorted(options.explicitlyRestoredSilenceIds),
      explicitlyRestoredSilenceRanges:
        normalizeSilenceRanges(options.explicitlyRestoredSilenceRanges),
      ...(policy.version === 'narration-v1' ? {
        audioSuggestionsEnabled: options.audioSuggestionsEnabled !== false,
        disabledAudioSuggestionIds: uniqueSorted(options.disabledAudioSuggestionIds),
        disabledAudioSuggestionGroups: uniqueSorted(options.disabledAudioSuggestionGroups),
        audioSuggestionRanges: normalizeRanges(options.audioSuggestionRanges),
      } : {}),
      policy,
    };
  }

  function createInitialEditState(options, restoredState, words) {
    const initial = createEditState(options);
    if (restoredState === undefined) return initial;
    try {
      if (!restoredState || !restoredState.policy
          || !Array.isArray(restoredState.currentDeletedWordIds)) throw new Error('编辑状态不完整');
      const restored = createEditState(restoredState);
      if (restored.policy.version !== initial.policy.version
          || JSON.stringify(restored.initialSuggestedWordDeletes) !== JSON.stringify(initial.initialSuggestedWordDeletes)) {
        throw new Error('策略或 AI 初选与当前输入不一致');
      }
      const known = new Set(words.map(word => String(word.id)));
      for (const id of [...restored.initialSuggestedWordDeletes, ...restored.currentDeletedWordIds,
        ...restored.explicitlyRestoredWordIds]) {
        if (!known.has(id)) throw new Error('编辑状态包含未知词');
      }
      return restored;
    } catch (error) {
      throw new Error(`无法恢复编辑起点：${error.message}`);
    }
  }

  function transitionEditState(state, action) {
    const next = createEditState(state);
    const deleted = new Set(next.currentDeletedWordIds);
    const restoredWords = new Set(next.explicitlyRestoredWordIds);
    const restoredSilence = new Set(next.explicitlyRestoredSilenceIds);
    switch (action && action.type) {
      case 'DELETE_WORD':
        deleted.add(String(action.wordId));
        restoredWords.delete(String(action.wordId));
        break;
      case 'RESTORE_WORD':
        if (deleted.delete(String(action.wordId))) restoredWords.add(String(action.wordId));
        break;
      case 'UNDO_RESTORE_WORD':
        if (restoredWords.delete(String(action.wordId))) deleted.add(String(action.wordId));
        break;
      case 'RESTORE_SILENCE':
        if (action.wasEffective === true) {
          const restoredRange = normalizeSilenceRanges([{
            ...action.range,
            silenceId: action.silenceId,
          }])[0];
          restoredSilence.add(String(action.silenceId));
          next.explicitlyRestoredSilenceRanges = normalizeSilenceRanges([
            ...next.explicitlyRestoredSilenceRanges,
            restoredRange,
          ]);
        }
        break;
      case 'UNDO_RESTORE_SILENCE': {
        const undoRange = normalizeSilenceRanges([action.range])[0];
        const removedIds = next.explicitlyRestoredSilenceRanges
          .filter(range => range.silenceId === String(action.silenceId)
            && range.startSample === undoRange.startSample
            && range.endSample === undoRange.endSample)
          .map(range => range.silenceId)
          .filter(Boolean);
        next.explicitlyRestoredSilenceRanges = next.explicitlyRestoredSilenceRanges
          .filter(range => !(range.silenceId === String(action.silenceId)
            && range.startSample === undoRange.startSample
            && range.endSample === undoRange.endSample));
        removedIds.forEach(id => {
          if (!next.explicitlyRestoredSilenceRanges.some(range => range.silenceId === id)) {
            restoredSilence.delete(id);
          }
        });
        break;
      }
      case 'ADD_MANUAL_DELETE_RANGE':
        next.manualDeleteRanges = normalizeRanges([...next.manualDeleteRanges, {
          ...action.range,
          ...(action.sourceSilenceId == null ? {} : { sourceSilenceId: action.sourceSilenceId }),
        }]);
        break;
      case 'REMOVE_MANUAL_DELETE_RANGE': {
        if (action.id != null) {
          next.manualDeleteRanges = next.manualDeleteRanges.filter(range => range.id !== String(action.id));
          break;
        }
        const target = normalizeRanges([{
          ...action.range,
          ...(action.sourceSilenceId == null ? {} : { sourceSilenceId: action.sourceSilenceId }),
        }])[0];
        next.manualDeleteRanges = next.manualDeleteRanges.filter(range => (
          range.startSample !== target.startSample
          || range.endSample !== target.endSample
          || (target.sourceSilenceId == null
            ? range.sourceSilenceId != null
            : range.sourceSilenceId !== target.sourceSilenceId)
        ));
        break;
      }
      case 'SET_POLICY':
        next.policy = Object.assign({}, next.policy, action.patch || {});
        break;
      case 'SET_ALL_AUDIO_SUGGESTIONS_ENABLED':
        if (next.policy.version !== 'narration-v1') throw new Error('当前策略不支持音频建议');
        next.audioSuggestionsEnabled = action.enabled === true;
        break;
      case 'SET_AUDIO_SUGGESTION_ENABLED':
      case 'SET_AUDIO_GROUP_ENABLED': {
        if (next.policy.version !== 'narration-v1') throw new Error('当前策略不支持音频建议');
        const group = action.type === 'SET_AUDIO_GROUP_ENABLED';
        const field = group ? 'disabledAudioSuggestionGroups' : 'disabledAudioSuggestionIds';
        const id = String(group ? action.groupId : action.id);
        const values = new Set(next[field]);
        if (action.enabled === true) values.delete(id); else values.add(id);
        next[field] = [...values];
        break;
      }
      case 'SET_AUDIO_SUGGESTION_RANGE':
        if (next.policy.version !== 'narration-v1') throw new Error('当前策略不支持音频建议');
        next.audioSuggestionRanges = normalizeRanges([
          ...next.audioSuggestionRanges.filter(range => range.id !== action.range?.id), action.range,
        ]);
        break;
      default:
        if (action && action.type) throw new Error(`未知 editState action: ${action.type}`);
    }
    next.currentDeletedWordIds = uniqueSorted([...deleted]);
    next.explicitlyRestoredWordIds = uniqueSorted([...restoredWords]);
    next.explicitlyRestoredSilenceIds = uniqueSorted([...restoredSilence]);
    next.explicitlyRestoredSilenceRanges = normalizeSilenceRanges(
      next.explicitlyRestoredSilenceRanges,
    );
    return createEditState(next);
  }

  return {
    DEFAULT_POLICY,
    createEditState,
    createInitialEditState,
    transitionEditState,
  };
});
