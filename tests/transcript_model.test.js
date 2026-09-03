'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let transcript = {};
try {
  transcript = require('../scripts/lib/transcript_model');
} catch (_) {
  // RED: words/asrBreaks 独立合同尚未实现。
}

test('provider words 映射到审核 sample clock 并生成稳定 ID，不混入 gap 伪 word', () => {
  assert.equal(typeof transcript.normalizeProviderWords, 'function');
  const raw = [
    { text: '你', start_time: 100, end_time: 250 },
    { text: '好', start_time: 500, end_time: 700 },
  ];
  const options = {
    reviewSampleRate: 48000,
    asrPresentationOffset: { seconds: 0.01, status: 'pending_user_validation' },
  };
  const first = transcript.normalizeProviderWords(raw, options);
  const second = transcript.normalizeProviderWords(raw, options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map(word => word.id), ['word-000000', 'word-000001']);
  assert.deepEqual(
    first.map(word => [word.startSample, word.endSample]),
    [[4320, 11520], [23520, 33120]],
  );
  assert.equal(first.some(word => 'isGap' in word), false);
});

test('asrBreaks 与 words 分离，只由相邻真实 word 的时间关系派生', () => {
  const words = [
    { id: 'w1', text: '前', startSample: 0, endSample: 4800 },
    { id: 'w2', text: '后', startSample: 16800, endSample: 21600 },
  ];
  const breaks = transcript.deriveAsrBreaks(words, {
    reviewSampleRate: 48000,
    minimumBreakSamples: 9600,
  });

  assert.deepEqual(breaks, [{
    id: 'asr-break-w1-w2',
    startSample: 4800,
    endSample: 16800,
    previousWordId: 'w1',
    nextWordId: 'w2',
  }]);
  assert.equal(words.length, 2);
});

test('provider 非空词缺失或无效时间时 fail closed，仅纯空白 token 可忽略', () => {
  const options = {
    reviewSampleRate: 48000,
    asrPresentationOffset: { seconds: 0, status: 'pending_user_validation' },
  };
  assert.deepEqual(
    transcript.normalizeProviderWords([{ text: '   ', start_time: -1, end_time: -1 }], options),
    [],
  );
  for (const item of [
    { text: '缺时间' },
    { text: '负时间', start_time: -1, end_time: 10 },
    { text: '倒序', start_time: 20, end_time: 10 },
  ]) {
    assert.throws(
      () => transcript.normalizeProviderWords([item], options),
      /非空 word.*时间无效/,
    );
  }
});
