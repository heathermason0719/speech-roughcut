'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let subtitleBlocks = {};
try {
  subtitleBlocks = require('../scripts/lib/subtitle_blocks');
} catch (_) {
  // RED 阶段模块尚不存在；下面的行为断言会明确指出缺少哪个公开函数。
}

test('工作台分行仅在不短于 0.4 秒的停顿后换行', () => {
  assert.equal(typeof subtitleBlocks.buildParagraphs, 'function');

  const words = [
    { text: '甲', start: 0, end: 0.2, isGap: false },
    { text: '', start: 0.2, end: 0.5, isGap: true },
    { text: '乙', start: 0.5, end: 0.7, isGap: false },
    { text: '', start: 0.7, end: 1.1, isGap: true },
    { text: '丙', start: 1.1, end: 1.3, isGap: false },
    { text: '', start: 1.3, end: 1.8, isGap: true },
    { text: '丁', start: 1.8, end: 2, isGap: false },
  ];

  const paragraphs = subtitleBlocks.buildParagraphs(words);
  assert.deepEqual(
    paragraphs.map(para => para.items.map(item => item.word.text).join('')),
    ['甲乙', '丙', '丁'],
  );
  assert.deepEqual(paragraphs.map(para => para.startTime), [0, 1.1, 1.8]);
});

test('开场长静音沿用旧工作台行为并归入第一句', () => {
  const paragraphs = subtitleBlocks.buildParagraphs([
    { text: '', start: 0, end: 1, isGap: true },
    { text: '开', start: 1, end: 1.2, isGap: false },
    { text: '场', start: 1.2, end: 1.4, isGap: false },
  ]);

  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].startTime, 1);
  assert.deepEqual(paragraphs[0].items.map(item => item.word.text), ['', '开', '场']);
});

test('短行保持不动且过长行优先在行内停顿处分成字幕块', () => {
  assert.equal(typeof subtitleBlocks.buildSubtitleBlocks, 'function');

  const words = [
    { text: '短', start: 0, end: 0.2, isGap: false },
    { text: '句', start: 0.2, end: 0.4, isGap: false },
    { text: '', start: 0.4, end: 0.8, isGap: true },
    { text: '一二三四五六七八九十', start: 0.8, end: 2.8, isGap: false },
    { text: '', start: 2.8, end: 3.1, isGap: true },
    { text: '甲乙丙丁戊己庚辛', start: 3.1, end: 4.7, isGap: false },
  ];

  const blocks = subtitleBlocks.buildSubtitleBlocks({
    words,
    finalKeeps: [{ start: 0, end: 5 }],
  });

  assert.deepEqual(blocks.map(block => block.text), [
    '短句',
    '一二三四五六七八九十',
    '甲乙丙丁戊己庚辛',
  ]);
});

test('删除文字被过滤且字幕块不会跨越剪辑断点', () => {
  const words = [
    { text: '甲', start: 0, end: 0.2, isGap: false },
    { text: '乙', start: 0.2, end: 0.4, isGap: false },
    { text: '丙', start: 0.6, end: 0.8, isGap: false },
    { text: '丁', start: 0.8, end: 1, isGap: false },
  ];

  const blocks = subtitleBlocks.buildSubtitleBlocks({
    words,
    selectedIndices: [1],
    finalKeeps: [
      { start: 0, end: 0.3 },
      { start: 0.5, end: 1 },
    ],
  });

  assert.deepEqual(blocks, [
    { text: '甲', sourceStart: 0, sourceEnd: 0.2, timelineStart: 0, timelineEnd: 0.2, keepIndex: 0 },
    { text: '丙丁', sourceStart: 0.6, sourceEnd: 1, timelineStart: 0.4, timelineEnd: 0.8, keepIndex: 1 },
  ]);
});

test('英文字符按半个汉字计宽且不会拆开英文词', () => {
  const blocks = subtitleBlocks.buildSubtitleBlocks({
    words: [
      { text: '一二三四五六七八九十', start: 0, end: 2, isGap: false },
      { text: 'FinalCut', start: 2, end: 3, isGap: false },
    ],
    finalKeeps: [{ start: 0, end: 3 }],
  });

  assert.deepEqual(blocks.map(block => block.text), ['一二三四五六七八九十FinalCut']);
});
