'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

test('README 与 SKILL 锁定当前媒体、时间、学习和人工验收合同', () => {
  const readme = read('README.md');
  const skill = read('SKILL.md');
  for (const required of [
    'review_audio.mp3',
    'MP3',
    'M4A',
    'WAV',
    'CFR',
    '仅支持 CFR，请先转码为 CFR 后重新执行',
    'PCM',
    'compiledCutPlan',
    'learning_diff.json',
    '显式提供',
    '原始资产',
    'Final Cut Pro',
  ]) {
    assert.equal(readme.includes(required), true, `README: ${required}`);
    assert.equal(skill.includes(required), true, `SKILL: ${required}`);
  }
  assert.match(skill, /pending_user_validation/);
  assert.match(skill, /不搜索任何 output/);
  assert.match(readme, /产品级最终通过承诺/);
  assert.match(skill, /不得宣称产品级最终 PASS/);
});

test('文档不再陈述旧流程合同', () => {
  const currentDocs = `${read('README.md')}\n${read('SKILL.md')}\n${read('用户习惯/经验规则.md')}`;
  const forbidden = [
    ['音频原文件', '直通'].join(''),
    ['direct', 'audio'].join('-'),
    ['legacy', 'proxy'].join('-'),
    ['review', 'log'].join('_'),
    ['批量 ', 'glob'].join(''),
    ['旧 invocation ', '重开'].join(''),
    ['波形不', '漂移'].join(''),
    ['media', 'manifest.json'].join('_'),
    ['silence', 'periods.json'].join('_'),
  ];
  forbidden.forEach(value => assert.equal(currentDocs.includes(value), false, value));
});

test('许可证和 attribution 保持冻结基线', () => {
  const license = fs.readFileSync(path.join(root, 'LICENSE'));
  assert.equal(
    crypto.createHash('sha256').update(license).digest('hex'),
    '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0',
  );
  const readme = read('README.md');
  for (const required of [
    'videocut-skills',
    '由 **栗氪聊AI** 创建',
    'AGPL-3.0',
    'Copyright © 2026 栗氪聊AI',
    '显著修改说明',
  ]) {
    assert.equal(readme.includes(required), true, required);
  }
});
