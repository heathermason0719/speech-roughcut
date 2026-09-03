'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeArtifactPair } = require('../scripts/lib/artifact_pair');

test('FCPXML 与 learning diff 成组提交，成功后不留临时文件', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-artifact-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const xmlPath = path.join(root, 'output.fcpxml');
  const diffPath = path.join(root, 'learning_diff.json');

  writeArtifactPair([
    { path: xmlPath, data: '<fcpxml />' },
    { path: diffPath, data: '{"ok":true}\n' },
  ], { nonce: 'success' });

  assert.equal(fs.readFileSync(xmlPath, 'utf8'), '<fcpxml />');
  assert.equal(fs.readFileSync(diffPath, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(root).sort(), ['learning_diff.json', 'output.fcpxml']);
});

test('第二个产物提交失败时回滚整组，不留半套新产物', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-artifact-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const xmlPath = path.join(root, 'output.fcpxml');
  const diffPath = path.join(root, 'learning_diff.json');
  fs.writeFileSync(xmlPath, 'old xml');
  fs.writeFileSync(diffPath, 'old diff');
  let commitRenameCount = 0;
  const injectedFs = Object.create(fs);
  injectedFs.renameSync = (source, target) => {
    if (source.includes('.tmp-fixture-')) {
      commitRenameCount += 1;
      if (commitRenameCount === 2) throw new Error('injected second commit failure');
    }
    return fs.renameSync(source, target);
  };

  assert.throws(() => writeArtifactPair([
    { path: xmlPath, data: 'new xml' },
    { path: diffPath, data: 'new diff' },
  ], { fsModule: injectedFs, nonce: 'fixture' }), /injected second commit failure/);

  assert.equal(fs.readFileSync(xmlPath, 'utf8'), 'old xml');
  assert.equal(fs.readFileSync(diffPath, 'utf8'), 'old diff');
  assert.deepEqual(fs.readdirSync(root).sort(), ['learning_diff.json', 'output.fcpxml']);
});
