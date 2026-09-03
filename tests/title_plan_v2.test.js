'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { planTitleBlocks, visualWidth } = require('../scripts/lib/title_plan');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');

function plan(texts) {
  let tick = 0;
  const words = texts.map((text, index) => {
    const start = tick;
    tick += 10;
    return { id: `w${index}`, text, startSample: start, endSample: tick };
  });
  const wordTickRanges = Object.fromEntries(words.map(word => [word.id, {
    sourceStartTick: word.startSample,
    sourceEndTick: word.endSample,
  }]));
  return planTitleBlocks({
    words,
    retainedWordIds: words.map(word => word.id),
    asrBreaks: [],
    keeps: [{ sourceStartTick: 0, sourceEndTick: tick, outputStartTick: 0, outputEndTick: tick }],
    wordTickRanges,
    reviewSampleRate: 48000,
    maxVisualWidth: 14,
  });
}

test('短行保持不拆，ASCII 按半宽累计', () => {
  assert.equal(visualWidth('短句FinalCut'), 6);
  assert.deepEqual(plan(['短句', 'FinalCut']).map(block => block.text), ['短句FinalCut']);
});

test('超过 14 字视觉宽度时英文 token 不从中间拆开', () => {
  const blocks = plan(['一二三四五六七八九十', 'FinalCut', '甲']);
  assert.deepEqual(blocks.map(block => block.text), ['一二三四五六七八九十FinalCut', '甲']);
  assert.equal(blocks.flatMap(block => block.wordIds).length, 3);
});

test('词的中点被剪掉但仍有音频保留时，字幕不漏词也不改变音频切点', () => {
  const result = compileEdit({
    words: [{ id: 'edge', text: '里', startSample: 0, endSample: 9600 }],
    editState: createEditState({
      manualDeleteRanges: [{ startSample: 4640, endSample: 48000 }],
      policy: { autoSilenceEnabled: false },
    }),
    mediaContext: {
      review: { sampleRate: 48000, decodedSampleCount: 48000 },
      timebase: { kind: 'audio-samples', ticksPerSecond: 44100 },
      offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } },
    },
  });

  assert.deepEqual(result.keeps.map(k => [k.sourceStartTick, k.sourceEndTick]), [[0, 4263]]);
  assert.deepEqual(result.cuts.map(k => [k.sourceStartTick, k.sourceEndTick]), [[4263, 44100]]);
  assert.deepEqual(result.retainedWordIds, ['edge']);
  assert.deepEqual(result.titleBlocks, [{
    id: 'title-0000', text: '里', keepIndex: 0,
    sourceStartTick: 0, sourceEndTick: 4263,
    outputStartTick: 0, outputEndTick: 4263,
    reviewStartSample: 0, reviewEndSample: 4640,
    wordIds: ['edge'],
  }]);
});

function slicedWord(keepRanges, retainedWordIds = ['word']) {
  let outputTick = 0;
  const keeps = keepRanges.map(([start, end]) => {
    const keep = {
      sourceStartTick: start, sourceEndTick: end,
      reviewStartSample: start, reviewEndSample: end,
      outputStartTick: outputTick, outputEndTick: outputTick + end - start,
    };
    outputTick = keep.outputEndTick;
    return keep;
  });
  return planTitleBlocks({
    words: [{ id: 'word', text: '词', startSample: 0, endSample: 100 }],
    retainedWordIds, asrBreaks: [], keeps, reviewSampleRate: 48000,
    wordTickRanges: { word: { sourceStartTick: 0, sourceEndTick: 100 } },
  });
}

test('只保留词尾时字幕裁到实际保留范围', () => {
  assert.deepEqual(slicedWord([[80, 120]]), [{
    id: 'title-0000', text: '词', keepIndex: 0,
    sourceStartTick: 80, sourceEndTick: 100,
    outputStartTick: 0, outputEndTick: 20,
    reviewStartSample: 80, reviewEndSample: 100, wordIds: ['word'],
  }]);
});

test('一个词横跨两段 keep 时只归到保留交集最多的片段', () => {
  assert.deepEqual(slicedWord([[0, 30], [60, 100]]), [{
    id: 'title-0000', text: '词', keepIndex: 1,
    sourceStartTick: 60, sourceEndTick: 100,
    outputStartTick: 30, outputEndTick: 70,
    reviewStartSample: 60, reviewEndSample: 100, wordIds: ['word'],
  }]);
});

test('两侧保留交集相等时稳定归到前段，不重复字幕', () => {
  const blocks = slicedWord([[0, 30], [70, 100]]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].keepIndex, 0);
  assert.deepEqual(blocks[0].wordIds, ['word']);
  assert.equal(blocks[0].sourceEndTick, 30);
});

test('没有正交集或未被保留的词不进入字幕', () => {
  assert.deepEqual(slicedWord([[100, 150]]), []);
  assert.deepEqual(slicedWord([]), []);
  assert.deepEqual(slicedWord([[0, 100]], []), []);
});
