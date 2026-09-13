'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeVolcResult } = require('../scripts/lib/volc_normalize');
const { validateCanonicalTranscript } = require('../scripts/lib/canonical_transcript');

const mediaContext = {
  review: { sampleRate: 48000, decodedSampleCount: 96000 },
  offsets: { asrPresentationOffset: { seconds: 0.05, status: 'pending_user_validation' } },
};
const timed = (text, start_time = 100, end_time = 250) => ({ text, start_time, end_time });
const raw = (...utterances) => ({ result: { utterances } });

test('非空识别句没有 timed words 时明确失败，包括夹在有效句中的缺词句', () => {
  for (const missing of [undefined, [], [{ text: ' ' }]]) {
    assert.throws(() => normalizeVolcResult(raw(
      { text: '甲', words: [timed('甲')] },
      { text: '不能丢失', words: missing },
    ), mediaContext), /timed words|非空|缺少/);
  }
});

test('独立无时间空白保留英文和混合文本显示，不生成伪 word 或时间', () => {
  const result = normalizeVolcResult(raw({ words: [
    timed('Hello'), { text: ' ', start_time: -1, end_time: -1 },
    timed('世界', 700, 900), { text: '\t' }, timed('again', 950, 1100),
  ] }), mediaContext);
  assert.equal(result.words.map(word => word.text).join(''), 'Hello 世界\tagain');
  assert.deepEqual(result.words.map(({ id, startSample, endSample }) => [id, startSample, endSample]), [
    ['word-000000', 2400, 9600], ['word-000001', 31200, 40800], ['word-000002', 43200, 50400],
  ]);
});

test('utterance.text 补回分隔和标点，缺少任何识别实词时拒绝', () => {
  const result = normalizeVolcResult(raw({ text: 'Hello, 世界! ', words: [
    timed('Hello'), timed('世界', 700, 900),
  ] }), mediaContext);
  assert.equal(result.words.map(word => word.text).join(''), 'Hello, 世界! ');
  assert.throws(() => normalizeVolcResult(raw({ text: 'Hello missing 世界', words: [
    timed('Hello'), timed('世界', 700, 900),
  ] }), mediaContext), /对齐|遗漏/);
});

test('result.text 保留跨 utterance 的英文与混合分隔，不改变任何 word 时间', () => {
  const response = raw(
    { text: 'Hello', words: [timed('Hello')] },
    { text: '世界', words: [timed('世界', 700, 900)] },
    { text: 'again', words: [timed('again', 950, 1100)] },
  );
  const before = normalizeVolcResult(response, mediaContext);
  response.result.text = 'Hello, 世界! again';
  const after = normalizeVolcResult(response, mediaContext);
  assert.equal(after.words.map(word => word.text).join(''), 'Hello, 世界! again');
  assert.deepEqual(after.words.map(({ text, ...time }) => time), before.words.map(({ text, ...time }) => time));
  assert.deepEqual(after.asrBreaks, before.asrBreaks);
});

test('result 全文含有 utterances 无法表达的识别实词时明确失败', () => {
  const response = raw({ text: 'Hello', words: [timed('Hello')] });
  response.result.text = 'Hello missing';
  assert.throws(() => normalizeVolcResult(response, mediaContext), /对齐|遗漏/);
});

test('纯中文 words 保持文本、sample 时间及派生 breaks', () => {
  const result = normalizeVolcResult(raw({ text: '甲乙', words: [
    timed('甲'), timed('乙', 700, 900),
  ] }), mediaContext);
  assert.deepEqual(result.words, [
    { id: 'word-000000', text: '甲', startSample: 2400, endSample: 9600 },
    { id: 'word-000001', text: '乙', startSample: 31200, endSample: 40800 },
  ]);
  assert.deepEqual(result.asrBreaks, [{
    id: 'asr-break-word-000000-word-000001', startSample: 9600, endSample: 31200,
    previousWordId: 'word-000000', nextWordId: 'word-000001',
  }]);
});

test('空响应或只有空白的响应拒绝作为成功字幕', () => {
  for (const result of [raw(), raw({ text: '' }), raw({ words: [{ text: ' ' }] })]) {
    assert.throws(() => normalizeVolcResult(result, mediaContext), /空|utterances|words/);
  }
});

test('canonical 验证不依赖 provider、offset 或中文字粒度，接受合法重叠词', () => {
  const canonical = { version: 1, words: [
    { id: 'sentence-unit', text: 'a whole phrase ', startSample: 0, endSample: 4000 },
    { id: 'unit-b', text: '混合语句', startSample: 3000, endSample: 6000 },
  ], asrBreaks: [] };
  assert.equal(validateCanonicalTranscript(canonical, { review: mediaContext.review }), canonical);
});

test('canonical 拒绝重复 ID、坏 sample 区间、乱序与伪造 break', () => {
  const valid = {
    version: 1,
    words: [{ id: 'w1', text: '甲', startSample: 0, endSample: 2400 }],
    asrBreaks: [],
  };
  const invalid = [
    { ...valid, version: 2 },
    { ...valid, words: [] },
    { ...valid, words: [valid.words[0], valid.words[0]] },
    ...[
      { id: '' }, { text: ' ' }, { text: 123 }, { startSample: 0.5 },
      { startSample: -1 }, { endSample: 0 }, { endSample: 96001 },
    ].map(change => ({ ...valid, words: [{ ...valid.words[0], ...change }] })),
    { ...valid, words: [
      { id: 'a', text: '甲', startSample: 1000, endSample: 2400 },
      { id: 'b', text: '乙', startSample: 500, endSample: 2500 },
    ] },
    { ...valid, asrBreaks: [{ id: 'invented', startSample: 1, endSample: 2 }] },
  ];
  for (const value of invalid) assert.throws(() => validateCanonicalTranscript(value, mediaContext));
  for (const review of [
    { sampleRate: 0, decodedSampleCount: 96000 },
    { sampleRate: 48000.5, decodedSampleCount: 96000 },
    { sampleRate: 48000, decodedSampleCount: 0 },
  ]) assert.throws(() => validateCanonicalTranscript(valid, { review }), /sample clock/);
});

test('adapter 拒绝非空词坏时间、映射越界和 sample 量化后的零长度', () => {
  for (const word of [
    { text: 'missing' }, timed('null', null, 250), timed('empty', '', 250),
    timed('negative', -1, 250), timed('backwards', 200, 100),
    timed('before offset', 0, 100), timed('past end', 100, 2100),
    timed('subsample', 100, 100.001),
  ]) assert.throws(() => normalizeVolcResult(raw({ words: [word] }), mediaContext));
});

test('canonical breaks 不能遗漏、更改端点或关联到非相邻词', () => {
  const valid = normalizeVolcResult(raw({ words: [timed('a'), timed('b', 700, 900)] }), mediaContext);
  for (const asrBreaks of [
    [], [{ ...valid.asrBreaks[0], endSample: 31201 }],
    [{ ...valid.asrBreaks[0], nextWordId: 'other' }],
  ]) assert.throws(() => validateCanonicalTranscript({ ...valid, asrBreaks }, mediaContext), /asrBreaks/);
});

test('canonical 边界拒绝混入 provider 字段，adapter 输出只包含中立字段', () => {
  const valid = normalizeVolcResult(raw({ words: [
    { ...timed('甲'), confidence: 0.9, provider_status: 'success' },
  ] }), mediaContext);
  assert.deepEqual(valid, { version: 1, words: [
    { id: 'word-000000', text: '甲', startSample: 2400, endSample: 9600 },
  ], asrBreaks: [] });
  assert.throws(() => validateCanonicalTranscript({ ...valid, provider: 'volc' }, mediaContext));
  assert.throws(() => validateCanonicalTranscript({ ...valid,
    words: [{ ...valid.words[0], start_time: 100 }],
  }, mediaContext));
});
