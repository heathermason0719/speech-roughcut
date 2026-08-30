'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let compat = {};
try {
  compat = require('../scripts/lib/transcribe_compat');
} catch (_) {
  // RED 阶段模块尚不存在。
}

test('auto 轮到极速版时 M4A 改走标准版', () => {
  assert.equal(typeof compat.selectEngineForFormat, 'function');
  assert.equal(compat.selectEngineForFormat({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    extension: 'm4a',
  }), 'v3-standard');
});

test('显式指定极速版处理 M4A 时给出明确错误', () => {
  assert.throws(() => compat.selectEngineForFormat({
    requestedEngine: 'flash',
    selectedEngine: 'flash',
    extension: 'm4a',
  }), /M4A.*极速版.*不支持/);
});

for (const extension of ['mp3', 'wav']) {
  test(`${extension} 保持 auto 已选择的转写引擎`, () => {
    assert.equal(compat.selectEngineForFormat({
      requestedEngine: 'auto',
      selectedEngine: 'flash',
      extension,
    }), 'flash');
    assert.equal(compat.selectEngineForFormat({
      requestedEngine: 'auto',
      selectedEngine: 'v3-standard',
      extension,
    }), 'v3-standard');
  });
}

test('auto 遇到超过极速版上限的兼容音频时改走标准版', () => {
  assert.equal(compat.selectEngineForFormat({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    extension: 'wav',
    sizeBytes: 100 * 1024 * 1024 + 1,
    duration: 30,
  }), 'v3-standard');
  assert.equal(compat.selectEngineForFormat({
    requestedEngine: 'auto',
    selectedEngine: 'flash',
    extension: 'mp3',
    sizeBytes: 1024,
    duration: 2 * 60 * 60 + 0.001,
  }), 'v3-standard');
});

test('显式引擎在上传前拒绝超过自身上限的音频', () => {
  assert.throws(() => compat.selectEngineForFormat({
    requestedEngine: 'flash',
    selectedEngine: 'flash',
    extension: 'wav',
    sizeBytes: 100 * 1024 * 1024 + 1,
    duration: 30,
  }), /极速版.*100MB/);
  assert.throws(() => compat.selectEngineForFormat({
    requestedEngine: 'v3-standard',
    selectedEngine: 'v3-standard',
    extension: 'mp3',
    sizeBytes: 512 * 1024 * 1024 + 1,
    duration: 30,
  }), /标准版.*512MB/);
});
