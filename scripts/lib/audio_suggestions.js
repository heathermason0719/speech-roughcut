(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AudioSuggestions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function assertRange(range, durationSamples) {
    if (!Number.isSafeInteger(range.startSample) || !Number.isSafeInteger(range.endSample)
        || range.startSample < 0 || range.endSample > durationSamples || range.endSample <= range.startSample) {
      throw new Error('音频建议范围必须使用有效整数 sample 边界');
    }
  }

  // These are authored decisions for one recording, not detections or a duration-based rule.
  function validateAudioSuggestions(suggestions, words, durationSamples) {
    if (!Array.isArray(suggestions)) throw new Error('音频建议必须为数组');
    const ids = new Set(), groups = new Map();
    for (const item of suggestions) {
      if (!item || ['id', 'groupId', 'groupLabel', 'reason', 'basis'].some(key =>
        typeof item[key] !== 'string' || !item[key].trim())) throw new Error('音频建议缺少身份、分组、理由或证据');
      if (ids.has(item.id)) throw new Error('音频建议 ID 重复');
      ids.add(item.id);
      if (groups.has(item.groupId) && groups.get(item.groupId) !== item.groupLabel) throw new Error('音频建议分组名称不一致');
      groups.set(item.groupId, item.groupLabel);
      assertRange(item, durationSamples);
      if (words.some(word => word.startSample < item.endSample && word.endSample > item.startSample)) {
        throw new Error(`音频建议 ${item.id} 跨越 word；请核验原声并单独选择范围`);
      }
    }
    return suggestions;
  }

  function resolveAudioSuggestions(suggestions, state, durationSamples) {
    const ids = new Set(suggestions.map(item => item.id));
    const groups = new Set(suggestions.map(item => item.groupId));
    const disabled = new Set(state.disabledAudioSuggestionIds || []);
    const disabledGroups = new Set(state.disabledAudioSuggestionGroups || []);
    for (const id of disabled) if (!ids.has(id)) throw new Error(`未知音频建议: ${id}`);
    for (const id of disabledGroups) if (!groups.has(id)) throw new Error(`未知音频建议分组: ${id}`);
    const overrides = new Map();
    for (const range of state.audioSuggestionRanges || []) {
      if (!ids.has(range.id) || overrides.has(range.id)) throw new Error('音频建议范围身份未知或重复');
      assertRange(range, durationSamples);
      overrides.set(range.id, range);
    }
    return suggestions.map(item => ({
      ...item, ...overrides.get(item.id), adjusted: overrides.has(item.id),
      enabled: state.audioSuggestionsEnabled !== false && !disabled.has(item.id) && !disabledGroups.has(item.groupId),
    }));
  }

  return { validateAudioSuggestions, resolveAudioSuggestions };
});
