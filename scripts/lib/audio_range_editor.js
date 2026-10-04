(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AudioRangeEditor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function formatTime(sample, rate) {
    const micros = Math.round(sample / rate * 1e6);
    const minutes = Math.floor(micros / 60000000);
    const seconds = ((micros % 60000000) / 1e6).toFixed(6).padStart(9, '0').replace(/0+$/, '').replace(/\.$/, '');
    return `${minutes}:${seconds}`;
  }

  function parseTime(value, rate) {
    const text = String(value).trim();
    if (!text) return null;
    if (!/^(?:\d+:)?\d+(?:\.\d{1,6})?$/.test(text)) throw new Error('请输入秒数或 分:秒，最多六位小数');
    const parts = text.split(':').map(Number);
    if (parts.length === 2 && parts[1] >= 60) throw new Error('分:秒中的秒数须小于 60');
    const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
    const sample = Math.round(seconds * rate);
    if (!Number.isSafeInteger(sample)) throw new Error('时间超出有效范围');
    return sample;
  }

  function mount({ element, sampleRate, durationSamples, getState, getCurrentSample,
    addRange, removeRange, audition, locate, onDraftChange }) {
    const document = element.ownerDocument;
    let draft = null;
    let adjustment = null;
    element.innerHTML = `
      <div class="card-head"><span class="label">/ 音频范围</span></div>
      <div class="range-body">
        <p class="range-hint">Shift 拖选波形，或在播放头设起止点。试听后再删除。</p>
        <label>起点 <input id="rangeStart" type="text" placeholder="分:秒" aria-label="音频范围起点"><button id="markRangeStart" type="button" title="I">设为播放头 · I</button></label>
        <label>终点 <input id="rangeEnd" type="text" placeholder="分:秒" aria-label="音频范围终点"><button id="markRangeEnd" type="button" title="O">设为播放头 · O</button></label>
        <div class="range-actions">
          <button id="auditionRange" type="button">▶ 试听选区</button>
          <button id="auditionRangeContext" type="button">听前后</button>
          <button id="deleteRange" type="button" title="Delete">删除选区 · Delete</button>
          <button id="clearRange" type="button">清除选区</button>
        </div>
        <p id="rangeMessage" class="range-hint" role="status" aria-live="polite"></p>
        <div id="manualRangeList" aria-label="已删除的音频范围"></div>
      </div>`;
    const start = element.querySelector('#rangeStart');
    const end = element.querySelector('#rangeEnd');
    const message = element.querySelector('#rangeMessage');
    const controls = ['auditionRange', 'auditionRangeContext', 'deleteRange'].map(id => element.querySelector('#' + id));
    function readDraft() {
      try {
        const startSample = parseTime(start.value, sampleRate);
        const endSample = parseTime(end.value, sampleRate);
        if (startSample === null || endSample === null) {
          draft = null;
          message.textContent = '选区尚未提交，不影响剪后结果。';
        } else {
          if (startSample < 0 || endSample > durationSamples || endSample <= startSample) {
            throw new Error('范围须在原声内，且终点晚于起点');
          }
          draft = { startSample, endSample };
          message.textContent = `选区 ${((endSample - startSample) / sampleRate).toFixed(3)} 秒 · ${adjustment ? '调整自动删除，尚未应用' : '尚未删除'}`;
        }
      } catch (error) { draft = null; message.textContent = error.message; }
      controls.forEach(button => { button.disabled = !draft; });
      onDraftChange();
    }
    function setRange(range, edit = null) {
      adjustment = edit;
      element.querySelector('#deleteRange').textContent = adjustment ? '应用删除边界 · Delete' : '删除选区 · Delete';
      start.value = range ? formatTime(range.startSample, sampleRate) : '';
      end.value = range ? formatTime(range.endSample, sampleRate) : '';
      readDraft();
    }
    start.addEventListener('input', readDraft);
    end.addEventListener('input', readDraft);
    for (const [id, input] of [['markRangeStart', start], ['markRangeEnd', end]]) {
      element.querySelector('#' + id).addEventListener('click', () => {
        input.value = formatTime(Math.max(0, Math.min(durationSamples, getCurrentSample())), sampleRate);
        readDraft();
      });
    }
    element.querySelector('#clearRange').addEventListener('click', () => setRange(null));
    element.querySelector('#auditionRange').addEventListener('click', () => { if (draft) audition(draft); });
    element.querySelector('#auditionRangeContext').addEventListener('click', () => {
      if (draft) audition({ startSample: Math.max(0, draft.startSample - sampleRate / 2),
        endSample: Math.min(durationSamples, draft.endSample + sampleRate / 2) });
    });
    element.querySelector('#deleteRange').addEventListener('click', () => {
      if (!draft) return;
      const range = { id: adjustment ? adjustment.id : document.defaultView.crypto.randomUUID(), ...draft };
      if (adjustment ? adjustment.apply(range) : addRange(range)) {
        setRange(null);
        message.textContent = '已应用范围。可播放剪后结果，或用 ⌘Z / Ctrl+Z 撤销。';
      }
    });
    function refresh() {
      const list = element.querySelector('#manualRangeList');
      list.replaceChildren();
      for (const range of getState().manualDeleteRanges) {
        const row = document.createElement('div');
        row.className = 'manual-range';
        row.dataset.rangeId = range.id;
        row.dataset.startSample = range.startSample;
        const label = document.createElement('button');
        label.type = 'button';
        label.textContent = `${formatTime(range.startSample, sampleRate)}–${formatTime(range.endSample, sampleRate)}`;
        label.title = '定位已删除范围；可试听原声';
        label.addEventListener('click', () => { setRange(range); locate(range); });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.action = 'remove';
        remove.textContent = '取消删除';
        remove.addEventListener('click', () => {
          if (removeRange(range.id)) message.textContent = '已取消此范围删除；其他词级或范围删除仍有效。';
        });
        row.append(label, remove); list.appendChild(row);
      }
    }
    readDraft(); refresh();
    return { setRange, refresh, getDraft: () => draft };
  }
  return { mount, formatTime, parseTime };
});
