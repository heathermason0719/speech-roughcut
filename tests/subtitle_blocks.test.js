'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildParagraphs } = require('../scripts/lib/subtitle_blocks');

const words = [
  { id: 'word-000000', text: '甲', startSample: 0, endSample: 9600 },
  { id: 'word-000001', text: '乙', startSample: 12000, endSample: 21600 },
  { id: 'word-000002', text: '丙', startSample: 45600, endSample: 55200 },
  { id: 'word-000003', text: '丁', startSample: 57600, endSample: 67200 },
];

const asrBreaks = [
  { id: 'asr-short', previousWordId: 'word-000000', nextWordId: 'word-000001', startSample: 9600, endSample: 12000 },
  { id: 'asr-long', previousWordId: 'word-000001', nextWordId: 'word-000002', startSample: 21600, endSample: 45600 },
  { id: 'asr-short-2', previousWordId: 'word-000002', nextWordId: 'word-000003', startSample: 55200, endSample: 57600 },
];

test('工作台分行只消费独立 asrBreaks，0.4 秒以上才换段', () => {
  const paragraphs = buildParagraphs({ words, asrBreaks, reviewSampleRate: 48000 });
  assert.deepEqual(paragraphs.map(item => item.wordIds), [
    ['word-000000', 'word-000001'],
    ['word-000002', 'word-000003'],
  ]);
  assert.deepEqual(paragraphs.map(item => item.startSample), [0, 45600]);
  assert.equal(paragraphs[0].breakAfter.id, 'asr-long');
  assert.equal(words.some(word => Object.hasOwn(word, 'isGap')), false);
});

test('ASR break 只影响布局，不返回删除选择或静音事实', () => {
  const paragraphs = buildParagraphs({ words, asrBreaks, reviewSampleRate: 48000 });
  assert.equal(JSON.stringify(paragraphs).includes('selected'), false);
  assert.equal(JSON.stringify(paragraphs).includes('silence'), false);
});
