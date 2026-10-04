(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio_suggestions'), require('./audio_range_editor'));
  else root.AudioSuggestionEditor = factory(root.AudioSuggestions, root.AudioRangeEditor);
})(typeof self !== 'undefined' ? self : this, function (AudioSuggestions, AudioRangeEditor) {
  'use strict';
  function mount({ element, suggestions, sampleRate, durationSamples, getState, dispatch, locate, audition, editRange }) {
    const document = element.ownerDocument;
    element.innerHTML = `<div class="card-head"><span class="label">/ 自动粗剪</span></div>
      <div class="range-body">
        <label><input id="enableAudioSuggestions" type="checkbox"> 采用本次音频建议</label>
        <p id="audioSuggestionSummary" class="range-hint" role="status"></p>
        <details><summary>按类型恢复 / 采用</summary><div id="audioSuggestionGroups"></div></details>
        <label>当前位置 <select id="audioSuggestionSelect" aria-label="自动粗剪位置"></select></label>
        <div class="range-actions"><button id="previousSuggestion" type="button">上一处</button><button id="nextSuggestion" type="button">下一处</button></div>
        <p id="suggestionReason" class="range-hint"></p>
        <label><input id="suggestionEnabled" type="checkbox"> 采用本处删除</label>
        <div class="range-actions"><button id="auditionSuggestion" type="button">▶ 听附近原声</button><button id="adjustSuggestion" type="button">调整删除边界</button></div>
        <details><summary>判断依据</summary><p id="suggestionBasis" class="range-hint"></p></details>
        <p class="range-hint">恢复只撤销对应的自动处理，保留你的删词与独立删音。改动可用 ⌘Z / Ctrl+Z 撤销。</p>
      </div>`;
    const all = element.querySelector('#enableAudioSuggestions');
    const select = element.querySelector('#audioSuggestionSelect');
    const enabled = element.querySelector('#suggestionEnabled');
    const groups = new Map(suggestions.map(item => [item.groupId, item.groupLabel]));
    const groupInputs = new Map();
    let currentId = suggestions[0]?.id;
    const resolved = () => AudioSuggestions.resolveAudioSuggestions(suggestions, getState(), durationSamples);
    const current = () => resolved().find(item => item.id === currentId);
    const time = sample => AudioRangeEditor.formatTime(sample, sampleRate);
    for (const [id, name] of groups) {
      const label = document.createElement('label'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.dataset.audioGroup = id;
      checkbox.addEventListener('change', () => dispatch({ type:'SET_AUDIO_GROUP_ENABLED', groupId:id, enabled:checkbox.checked }));
      label.append(checkbox, ` ${name}`); element.querySelector('#audioSuggestionGroups').append(label);
      groupInputs.set(id, checkbox);
    }
    all.addEventListener('change', () => dispatch({ type:'SET_ALL_AUDIO_SUGGESTIONS_ENABLED', enabled:all.checked }));
    enabled.addEventListener('change', () => { if (currentId) dispatch({type:'SET_AUDIO_SUGGESTION_ENABLED',id:currentId,enabled:enabled.checked}); });
    function refresh() {
      const state = getState(), items = resolved(), item = items.find(item => item.id === currentId);
      all.checked = state.audioSuggestionsEnabled !== false; all.disabled = !items.length;
      element.querySelector('#audioSuggestionSummary').textContent = items.length
        ? `${items.filter(item => item.enabled).length} / ${items.length} 处采用 · 每处均可调整或恢复`
        : '本次未提供音频建议；可用波形选择任意声音。';
      for (const [id, input] of groupInputs) {
        input.checked = !state.disabledAudioSuggestionGroups.includes(id); input.disabled = !all.checked;
      }
      select.replaceChildren();
      for (const value of items) {
        const option = document.createElement('option'); option.value = value.id;
        option.textContent = `${time(value.startSample)} · ${value.groupLabel}${value.enabled ? '' : ' · 已恢复'}${value.adjusted ? ' · 已调整' : ''}`;
        select.append(option);
      }
      select.value = currentId || ''; select.disabled = !item;
      for (const id of ['previousSuggestion','nextSuggestion','auditionSuggestion','adjustSuggestion']) element.querySelector('#'+id).disabled = !item;
      enabled.checked = !!item && !state.disabledAudioSuggestionIds.includes(item.id);
      enabled.disabled = !item || !all.checked || state.disabledAudioSuggestionGroups.includes(item.groupId);
      element.querySelector('#suggestionReason').textContent = item ? `${time(item.startSample)}–${time(item.endSample)} · ${item.reason}${item.enabled ? '' : '（已恢复此自动处理）'}` : '';
      element.querySelector('#suggestionBasis').textContent = item?.basis || '';
    }
    function focus(id) {
      if (!suggestions.some(item => item.id === id)) return;
      currentId = id; refresh(); locate(current()); element.scrollIntoView({block:'nearest'});
    }
    select.addEventListener('change', () => focus(select.value));
    for (const [id, step] of [['previousSuggestion',-1],['nextSuggestion',1]]) {
      element.querySelector('#'+id).addEventListener('click', () => {
        if (suggestions.length) focus(suggestions[(suggestions.findIndex(item => item.id === currentId) + step + suggestions.length) % suggestions.length].id);
      });
    }
    element.querySelector('#auditionSuggestion').addEventListener('click', () => {
      const item = current(); if (item) audition({startSample:Math.max(0,item.startSample-sampleRate),endSample:Math.min(durationSamples,item.endSample+sampleRate)});
    });
    element.querySelector('#adjustSuggestion').addEventListener('click', () => {
      const item = current(); if (item) { locate(item); editRange(item); }
    });
    refresh(); return { refresh, focus };
  }
  return { mount };
});
