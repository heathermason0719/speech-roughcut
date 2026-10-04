'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { writeExportRevision } = require('../scripts/lib/export_revision');
const { makeAudio } = require('./helpers/media_fixtures');

const serverScript = path.resolve(__dirname, '../scripts/review_server.js');
const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const { port } = reservation.address();
      reservation.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startServer(root, contextFile, port) {
  const child = spawn(process.execPath, [serverScript, String(port), contextFile], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${errors}`)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY_PORT=')) {
        clearTimeout(timeout);
        child.reviewServerOutput = () => output;
        resolve(child);
      }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`server exited early ${code}: ${output}${errors}`));
    });
  });
}

async function waitFor(description, check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function fixture(root) {
  const source = makeAudio(root, 'wav', { duration: 4 });
  const transcribeDir = path.join(root, '1_转录');
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
  const contextFile = path.join(transcribeDir, 'media_context.json');
  const mediaContext = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const words = [
    { id: 'word-000000', text: '保留字幕', startSample: 4800, endSample: 38400 },
    { id: 'word-000001', text: 'AI 建议', startSample: 57600, endSample: 86400 },
    { id: 'word-000002', text: '用户删除', startSample: 105600, endSample: 134400 },
  ];
  fs.writeFileSync(path.join(root, 'data.json'), `${JSON.stringify({
    words, asrBreaks: [], initialSuggestedWordDeletes: ['word-000001'], mediaContext,
  })}\n`);
  const plan = deleted => compileEdit({
    words, asrBreaks: [], detectedSilence: [], mediaContext,
    editState: createEditState({
      initialSuggestedWordDeletes: ['word-000001'],
      currentDeletedWordIds: deleted,
    }),
  });
  return { contextFile, first: plan([]), second: plan(['word-000002']) };
}

async function exportPlan(port, compiledCutPlan, includeTitles = true) {
  const response = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compiledCutPlan, includeTitles }),
  });
  return { response, body: await response.json() };
}

test('each export revision preserves its own FCPXML, learning diff, and download while a second server is rejected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase3-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root);
  const [firstPort, secondPort] = await Promise.all([freePort(), freePort()]);
  const firstServer = await startServer(root, contract.contextFile, firstPort);
  t.after(() => firstServer.kill('SIGTERM'));
  await assert.rejects(startServer(root, contract.contextFile, secondPort), /已有活动写入所有者/);
  const stopped = new Promise(resolve => firstServer.once('exit', resolve));
  firstServer.kill('SIGTERM');
  await stopped;
  const secondServer = await startServer(root, contract.contextFile, secondPort);
  t.after(() => secondServer.kill('SIGTERM'));

  const [first, second] = await Promise.all([
    exportPlan(secondPort, contract.first, true),
    exportPlan(secondPort, contract.second, false),
  ]);
  for (const result of [first, second]) assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.notEqual(first.body.revision, second.body.revision);
  assert.match(first.body.downloadUrl, new RegExp(`/api/download/fcpxml/${first.body.revision}$`));
  assert.match(second.body.downloadUrl, new RegExp(`/api/download/fcpxml/${second.body.revision}$`));
  assert.notEqual(first.body.output, second.body.output);
  assert.notEqual(first.body.learningDiff, second.body.learningDiff);

  const [firstXml, secondXml] = await Promise.all([
    fetch(`http://127.0.0.1:${secondPort}${first.body.downloadUrl}`).then(response => response.text()),
    fetch(`http://127.0.0.1:${secondPort}${second.body.downloadUrl}`).then(response => response.text()),
  ]);
  assert.match(firstXml, /<title /);
  assert.doesNotMatch(secondXml, /<title /);
  assert.match(firstXml, /用户删除/);
  assert.doesNotMatch(secondXml, /用户删除/);
  assert.match(fs.readFileSync(first.body.learningDiff, 'utf8'), /word-000001/);
  assert.match(fs.readFileSync(second.body.learningDiff, 'utf8'), /word-000002/);
  assert.match(firstXml, new RegExp(pathToFileURL(first.body.output).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(firstXml, /\.tmp-/);
});

test('review ownership survives a killed lock supervisor while its Node worker remains alive', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase3-export-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root);
  const [firstPort, secondPort, thirdPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const launcher = await startServer(root, contract.contextFile, firstPort);
  const lockPids = await waitFor('lock worker process details', () => {
    const output = launcher.reviewServerOutput();
    const supervisor = output.match(/LOCK_SUPERVISOR_PID=(\d+) LOCK_WORKER_PID=(\d+)/);
    const worker = output.match(/LOCK_WORKER_PID=(\d+) LOCK_WORKER_PARENT_PID=(\d+)/);
    return supervisor && worker ? {
      supervisorPid: Number(supervisor[1]), workerPid: Number(worker[1]), workerParentPid: Number(worker[2]),
    } : null;
  });
  const { supervisorPid, workerPid, workerParentPid } = lockPids;
  assert.equal(workerParentPid, supervisorPid);
  t.after(() => {
    try { process.kill(workerPid, 'SIGTERM'); } catch (_error) {}
    try { launcher.kill('SIGTERM'); } catch (_error) {}
  });

  process.kill(supervisorPid, 'SIGKILL');
  assert.equal((await fetch(`http://127.0.0.1:${firstPort}/video`)).status, 200);
  await assert.rejects(startServer(root, contract.contextFile, secondPort), /已有活动写入所有者/);

  process.kill(workerPid, 'SIGTERM');
  await waitFor('worker exit', () => {
    try { process.kill(workerPid, 0); return false; } catch (_error) { return true; }
  });
  const recovered = await startServer(root, contract.contextFile, thirdPort);
  t.after(() => recovered.kill('SIGTERM'));
});

test('failed revision publication preserves a prior downloadable pair and changed review data fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase3-export-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root);
  const port = await freePort();
  const server = await startServer(root, contract.contextFile, port);
  t.after(() => server.kill('SIGTERM'));

  const prior = await exportPlan(port, contract.first);
  assert.equal(prior.response.status, 200, JSON.stringify(prior.body));
  const priorXml = await fetch(`http://127.0.0.1:${port}${prior.body.downloadUrl}`).then(response => response.text());
  const priorLearning = fs.readFileSync(prior.body.learningDiff, 'utf8');
  const failingFs = {
    ...fs,
    renameSync() {
      const error = new Error('injected rename failure');
      error.code = 'EIO';
      throw error;
    },
  };
  assert.throws(() => writeExportRevision(root, temporaryDirectory => {
    fs.writeFileSync(path.join(temporaryDirectory, 'other.fcpxml'), '<fcpxml />');
    fs.writeFileSync(path.join(temporaryDirectory, 'learning_diff.json'), '{}');
    fs.writeFileSync(path.join(temporaryDirectory, 'edit_snapshot.json'), '{}');
    return { fcpxmlName: 'other.fcpxml', learningDiffName: 'learning_diff.json', snapshotName: 'edit_snapshot.json' };
  }, { fsModule: failingFs }), { code: 'EIO' });
  assert.equal(await fetch(`http://127.0.0.1:${port}${prior.body.downloadUrl}`).then(response => response.text()), priorXml);
  assert.equal(fs.readFileSync(prior.body.learningDiff, 'utf8'), priorLearning);

  const dataFile = path.join(root, 'data.json');
  const changed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  changed.words[0].text = '篡改后的审核数据';
  fs.writeFileSync(dataFile, `${JSON.stringify(changed)}\n`);
  const rejected = await exportPlan(port, contract.first);
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.permanent, true);
});

test('export write failure is retryable and a broken download stream does not kill the review server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase3-export-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root);
  fs.writeFileSync(path.join(root, 'exports'), 'blocked');
  const port = await freePort();
  const server = await startServer(root, contract.contextFile, port);
  t.after(() => server.kill('SIGTERM'));

  const failed = await exportPlan(port, contract.first);
  assert.equal(failed.response.status, 503, JSON.stringify(failed.body));
  fs.unlinkSync(path.join(root, 'exports'));
  const recovered = await exportPlan(port, contract.first);
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));

  fs.rmSync(recovered.body.output);
  fs.mkdirSync(recovered.body.output);
  await assert.rejects(fetch(`http://127.0.0.1:${port}${recovered.body.downloadUrl}`));
  const alive = await fetch(`http://127.0.0.1:${port}/video`);
  assert.equal(alive.status, 200);
});
