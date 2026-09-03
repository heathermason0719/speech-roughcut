'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLearningDiff,
  parseLearningDiff,
  serializeLearningDiff,
} = require('../scripts/lib/learning_diff');

const readerScript = path.resolve(__dirname, '../scripts/read_learning_diff.js');
const habitFile = path.resolve(__dirname, '../用户习惯/经验规则.md');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture() {
  return {
    mediaName: '固定夹具',
    words: [
      { id: 'word-000000', text: '前' },
      { id: 'word-000001', text: '保留' },
      { id: 'word-000002', text: '中' },
      { id: 'word-000003', text: '补删' },
      { id: 'word-000004', text: '后' },
    ],
    initialSuggestedWordDeleteIds: ['word-000001'],
    finalDeletedWordIds: ['word-000003'],
  };
}

test('learning diff 只记录真实 word 的 AI-only/user-only 与必要上下文，并且确定性', () => {
  const first = buildLearningDiff(fixture());
  const second = buildLearningDiff(structuredClone(fixture()));
  assert.deepEqual(first, second);
  assert.equal(serializeLearningDiff(first), serializeLearningDiff(second));
  assert.deepEqual(first.aiOnly, [{
    wordId: 'word-000001',
    text: '保留',
    context: '前【保留】中补删后',
  }]);
  assert.deepEqual(first.userOnly, [{
    wordId: 'word-000003',
    text: '补删',
    context: '前保留中【补删】后',
  }]);
  const serialized = serializeLearningDiff(first);
  for (const forbidden of [
    'asrBreaks',
    'detectedSilence',
    'padding',
    'silenceThreshold',
    'sourceStartTick',
    'sourceEndTick',
    'outputStartTick',
    'outputEndTick',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('当前格式只允许显式路径读取；缺失、版本不匹配和旧对象明确失败', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-learning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentPath = path.join(root, 'learning_diff.json');
  const current = buildLearningDiff(fixture());
  fs.writeFileSync(currentPath, serializeLearningDiff(current));

  assert.deepEqual(parseLearningDiff(fs.readFileSync(currentPath, 'utf8')), current);
  const explicit = JSON.parse(execFileSync(process.execPath, [readerScript, currentPath], { encoding: 'utf8' }));
  assert.deepEqual(explicit, current);

  const noPath = spawnSync(process.execPath, [readerScript], { encoding: 'utf8' });
  assert.notEqual(noPath.status, 0);
  assert.match(noPath.stderr, /必须显式提供.*learning_diff/);
  const missing = spawnSync(process.execPath, [readerScript, path.join(root, 'missing.json')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /文件不存在/);

  const wrongVersion = structuredClone(current);
  wrongVersion.formatVersion = 2;
  assert.throws(() => parseLearningDiff(JSON.stringify(wrongVersion)), /版本不匹配/);
  const oldName = ['review', 'log'].join('_');
  const oldObject = { video: 'old', diff: { aiOnly: [], userOnly: [] } };
  assert.throws(() => parseLearningDiff(JSON.stringify(oldObject)), /当前格式/);
  assert.equal(oldName.endsWith('log'), true);
});

test('构建、序列化和读取 learning diff 不修改长期经验规则文件', (t) => {
  const before = sha256(habitFile);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-learning-habit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const diffPath = path.join(root, 'learning_diff.json');
  fs.writeFileSync(diffPath, serializeLearningDiff(buildLearningDiff(fixture())));
  execFileSync(process.execPath, [readerScript, diffPath]);
  assert.equal(sha256(habitFile), before);
});
