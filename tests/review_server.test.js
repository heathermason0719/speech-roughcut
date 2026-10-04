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
const { parseLearningDiff } = require('../scripts/lib/learning_diff');
const { makeAudio } = require('./helpers/media_fixtures');

const serverScript = path.resolve(__dirname, '../scripts/review_server.js');
const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('审核服务器启动超时')), 5000);
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY_PORT=')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`审核服务器提前退出: ${code}\n${output}\n${errors}`));
    });
  });
}

async function post(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, json: await response.json() };
}

function fixtureContract(root) {
  const source = makeAudio(root, 'wav', { duration: 4 });
  const transcribeDir = path.join(root, '1_转录');
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
  const contextFile = path.join(transcribeDir, 'media_context.json');
  const mediaContext = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const words = [
    { id: 'word-000000', text: '保留字幕', startSample: 4800, endSample: 38400 },
    { id: 'word-000001', text: 'AI建议后保留', startSample: 57600, endSample: 86400 },
    { id: 'word-000002', text: '用户最终删除', startSample: 105600, endSample: 134400 },
  ];
  const editState = createEditState({
    initialSuggestedWordDeletes: ['word-000001'],
    currentDeletedWordIds: ['word-000002'],
  });
  const compiledCutPlan = compileEdit({
    words,
    asrBreaks: [],
    detectedSilence: [],
    editState,
    mediaContext,
  });
  fs.writeFileSync(path.join(root, 'data.json'), `${JSON.stringify({
    words,
    asrBreaks: [],
    initialSuggestedWordDeletes: ['word-000001'],
    mediaContext,
  }, null, 2)}\n`);
  return { source, contextFile, mediaContext, words, compiledCutPlan, editState };
}

test('审核接口只接受当前 compiledCutPlan，并按开关序列化 output-time 标题', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-server-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixtureContract(root);
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript, String(port), contract.contextFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitUntilReady(child);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { Origin: 'https://example.invalid' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.has('access-control-allow-origin'), false);

  const arbitraryPath = await fetch(
    `http://127.0.0.1:${port}/api/download/${encodeURIComponent('/etc/hosts')}`,
  );
  assert.equal(arbitraryPath.status, 404);

  for (const library of ['edit_state.js', 'title_plan.js', 'compile_edit.js', 'subtitle_blocks.js', 'review_workbench.js']) {
    const response = await fetch(`http://127.0.0.1:${port}/lib/${library}`);
    assert.equal(response.status, 200, library);
    assert.match(response.headers.get('content-type') || '', /javascript/);
  }

  const oldRequest = await post(port, {
    deleteList: [{ start: 1, end: 2 }],
    opts: {},
    includeTitles: true,
  });
  assert.equal(oldRequest.response.status, 400);
  assert.match(oldRequest.json.error, /compiledCutPlan/);

  for (const mutate of [
    plan => { plan.keeps[0].sourceStartTick = 0.5; },
    plan => { plan.cuts[0].sourceStartTick = -1; },
    plan => { plan.cuts[0].sourceStartTick = plan.keeps[0].sourceEndTick - 1; },
    plan => { plan.timebase.ticksPerSecond = 0; },
  ]) {
    const plan = structuredClone(contract.compiledCutPlan);
    mutate(plan);
    const result = await post(port, { compiledCutPlan: plan, includeTitles: true });
    assert.equal(result.response.status, 400, JSON.stringify(result.json));
    assert.equal(result.json.success, false);
  }

  const withTitles = await post(port, {
    compiledCutPlan: contract.compiledCutPlan,
    includeTitles: true,
  });
  assert.equal(withTitles.response.status, 200, JSON.stringify(withTitles.json));
  assert.equal(withTitles.json.success, true);
  const xml = fs.readFileSync(withTitles.json.output, 'utf8');
  assert.match(xml, /<title [^>]*lane="1"/);
  assert.match(xml, /保留字幕/);
  assert.match(xml, /AI建议后保留/);
  assert.doesNotMatch(xml, /用户最终删除/);
  assert.match(xml, new RegExp(pathToFileURL(contract.source).href.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(xml, /review_audio\.mp3/);

  const learningPath = path.join(root, 'exports', withTitles.json.revision, 'learning_diff.json');
  assert.equal(fs.realpathSync(withTitles.json.learningDiff), fs.realpathSync(learningPath));
  const learningDiff = parseLearningDiff(fs.readFileSync(learningPath, 'utf8'));
  assert.equal(learningDiff.mediaName, path.basename(contract.source));
  assert.deepEqual(learningDiff.aiOnly.map(item => item.wordId), ['word-000001']);
  assert.deepEqual(learningDiff.userOnly.map(item => item.wordId), ['word-000002']);
  assert.equal(withTitles.json.downloadUrl, `/api/download/fcpxml/${withTitles.json.revision}`);
  const download = await fetch(`http://127.0.0.1:${port}${withTitles.json.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), xml);

  const fcpDtd = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_8.dtd';
  if (fs.existsSync(fcpDtd)) {
    execFileSync('xmllint', ['--noout', '--dtdvalid', pathToFileURL(fcpDtd).href, withTitles.json.output]);
  }

  const withoutTitles = await post(port, {
    compiledCutPlan: contract.compiledCutPlan,
    includeTitles: false,
  });
  assert.equal(withoutTitles.response.status, 200);
  const xmlWithoutTitles = fs.readFileSync(withoutTitles.json.output, 'utf8');
  assert.doesNotMatch(xmlWithoutTitles, /<title |<effect id="r3"/);
});

test('服务端冻结单次 invocation 身份，context 或 data 被替换后拒绝错源导出', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-server-identity-'));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-server-other-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  const contract = fixtureContract(root);
  const other = fixtureContract(otherRoot);
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript, String(port), contract.contextFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitUntilReady(child);

  fs.copyFileSync(other.contextFile, contract.contextFile);
  fs.copyFileSync(path.join(otherRoot, 'data.json'), path.join(root, 'data.json'));
  const result = await post(port, {
    compiledCutPlan: contract.compiledCutPlan,
    includeTitles: true,
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.json));
  assert.match(result.json.error, /invocation.*变化/);
  assert.equal(fs.existsSync(path.join(root, `${path.basename(contract.source, path.extname(contract.source))}_cut.fcpxml`)), false);
  assert.equal(fs.existsSync(path.join(root, 'learning_diff.json')), false);
});

test('源文件轻量指纹在服务启动后变化时导出 fail closed 且不生成 XML', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-server-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixtureContract(root);
  const output = path.join(root, `${path.basename(contract.source, path.extname(contract.source))}_cut.fcpxml`);
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript, String(port), contract.contextFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitUntilReady(child);
  fs.appendFileSync(contract.source, 'fingerprint changed');

  const result = await post(port, {
    compiledCutPlan: contract.compiledCutPlan,
    includeTitles: true,
  });
  assert.equal(result.response.status, 409);
  assert.match(result.json.error, /轻量指纹/);
  assert.equal(fs.existsSync(output), false);
});

test('服务端源码不保留旧语义编译与旧请求体职责', () => {
  const source = fs.readFileSync(serverScript, 'utf8');
  for (const forbidden of [
    'computeFinalKeeps',
    'selectedIndicesToSegments',
    'protectedSegments',
    'deleteList',
    'cutOpts',
    'toFCPTicks',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('导出保存可重放快照，拒绝状态计划错配，旧页面明确只保存计划', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roughcut-export-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const contract = fixtureContract(root);
  fs.writeFileSync(path.join(root, 'detected_silence.json'), '[]');
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript, String(port), contract.contextFile], {
    cwd:root, stdio:['ignore','pipe','pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitUntilReady(child);
  const editState = createEditState({ ...contract.editState, policy:{version:'conservative-v1'},
    manualDeleteRanges:[{id:'cough',startSample:43200,endSample:48000}] });
  const compiledCutPlan = compileEdit({ words:contract.words, asrBreaks:[], detectedSilence:[], editState, mediaContext:contract.mediaContext });
  const good = await post(port, { editState, compiledCutPlan, includeTitles:false });
  assert.equal(good.response.status,200,JSON.stringify(good.json));
  const snapshot = JSON.parse(fs.readFileSync(good.json.editSnapshot,'utf8'));
  assert.equal(snapshot.completeness,'complete');
  assert.deepEqual(snapshot.editState.manualDeleteRanges,[{id:'cough',startSample:43200,endSample:48000}]);
  const { replayEditSnapshot } = require('../scripts/lib/edit_snapshot');
  assert.deepEqual(replayEditSnapshot(snapshot),compiledCutPlan);
  const changed=structuredClone(snapshot); changed.inputs.words[0].endSample--;
  assert.throws(()=>replayEditSnapshot(changed),/hash|指纹/);
  const count=fs.readdirSync(path.join(root,'exports')).length;
  const mismatch=await post(port, {editState: {...editState,manualDeleteRanges:[]},compiledCutPlan,includeTitles:false});
  assert.equal(mismatch.response.status,400);
  assert.equal(fs.readdirSync(path.join(root,'exports')).length,count);
  const legacy=await post(port, {compiledCutPlan:contract.compiledCutPlan,includeTitles:false});
  assert.equal(legacy.response.status,200,JSON.stringify(legacy.json));
  const partial=JSON.parse(fs.readFileSync(legacy.json.editSnapshot,'utf8'));
  assert.equal(partial.completeness,'plan-only'); assert.equal(partial.editState,null);
  assert.throws(()=>replayEditSnapshot(partial),/完整编辑状态/);
  fs.writeFileSync(path.join(root,'detected_silence.json'),'[{"id":"changed"}]');
  const changedPcm=await post(port,{editState,compiledCutPlan,includeTitles:false});
  assert.equal(changedPcm.response.status,409);
  assert.equal(changedPcm.json.permanent,true);
});
