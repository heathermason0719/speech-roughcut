'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let compat = {};
try {
  compat = require('../scripts/lib/transcribe_compat');
} catch (_) {
  // RED: 新合同尚未实现。
}

function review(overrides = {}) {
  return {
    extension: 'mp3',
    sizeBytes: 1024,
    decodedSampleCount: 48000,
    sampleRate: 48000,
    ...overrides,
  };
}

test('源 M4A 不再改变实际审核 MP3 的引擎选择', () => {
  assert.equal(typeof compat.selectEngineForReview, 'function');
  assert.equal(compat.selectEngineForReview({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    review: review(),
  }), 'flash');
});

test('转写限制只使用审核文件大小与 decoded-sample duration', () => {
  assert.equal(compat.selectEngineForReview({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    review: review({ decodedSampleCount: 2 * 60 * 60 * 48000 + 1 }),
  }), 'v3-standard');

  assert.throws(() => compat.selectEngineForReview({
    requestedEngine: 'flash',
    selectedEngine: 'flash',
    review: review({ sizeBytes: 100 * 1024 * 1024 + 1 }),
  }), /极速版.*100MB/);

  assert.throws(() => compat.selectEngineForReview({
    requestedEngine: 'v3-standard',
    selectedEngine: 'v3-standard',
    review: review({ decodedSampleCount: 5 * 60 * 60 * 48000 + 1 }),
  }), /标准版.*5 小时/);
});

test('非 MP3 审核文件在上传前明确失败', () => {
  assert.throws(() => compat.selectEngineForReview({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    review: review({ extension: 'm4a' }),
  }), /审核文件.*MP3/);
});
