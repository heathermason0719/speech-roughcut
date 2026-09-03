(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_POLICY = Object.freeze({
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
      return { startSample, endSample };
    }).sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);
  }

  function normalizeSilenceRanges(ranges) {
    return (ranges || []).map(range => {
      const normalized = normalizeRanges([range])[0];
      return {
        ...(range.silenceId == null ? {} : { silenceId: String(range.silenceId) }),
        ...normalized,
      };
    }).sort((left, right) => left.startSample - right.startSample
      || left.endSample - right.endSample
      || String(left.silenceId || '').localeCompare(String(right.silenceId || '')));
  }

  function rangesOverlap(left, right) {
    return left.startSample < right.endSample && left.endSample > right.startSample;
  }

  function createEditState(options = {}) {
    const initial = uniqueSorted(options.initialSuggestedWordDeletes);
    const current = options.currentDeletedWordIds === undefined
      ? initial.slice()
      : uniqueSorted(options.currentDeletedWordIds);
    return {
      initialSuggestedWordDeletes: initial,
      currentDeletedWordIds: current,
      manualDeleteRanges: normalizeRanges(options.manualDeleteRanges),
      explicitlyRestoredWordIds: uniqueSorted(options.explicitlyRestoredWordIds),
      explicitlyRestoredSilenceIds: uniqueSorted(options.explicitlyRestoredSilenceIds),
      explicitlyRestoredSilenceRanges:
        normalizeSilenceRanges(options.explicitlyRestoredSilenceRanges),
      policy: Object.assign({}, DEFAULT_POLICY, options.policy || {}),
    };
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
          .filter(range => rangesOverlap(range, undoRange))
          .map(range => range.silenceId)
          .filter(Boolean);
        next.explicitlyRestoredSilenceRanges = next.explicitlyRestoredSilenceRanges
          .filter(range => !rangesOverlap(range, undoRange));
        restoredSilence.delete(String(action.silenceId));
        removedIds.forEach(id => restoredSilence.delete(id));
        break;
      }
      case 'ADD_MANUAL_DELETE_RANGE':
        next.manualDeleteRanges = normalizeRanges([...next.manualDeleteRanges, action.range]);
        break;
      case 'REMOVE_MANUAL_DELETE_RANGE': {
        const target = normalizeRanges([action.range])[0];
        next.manualDeleteRanges = next.manualDeleteRanges.filter(range => (
          range.startSample !== target.startSample || range.endSample !== target.endSample
        ));
        break;
      }
      case 'SET_POLICY':
        next.policy = Object.assign({}, next.policy, action.patch || {});
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
    return next;
  }

  return {
    DEFAULT_POLICY,
    createEditState,
    transitionEditState,
  };
});
