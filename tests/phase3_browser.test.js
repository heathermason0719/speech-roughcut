'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeMarkerWav } = require('./helpers/media_fixtures');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');
const generateReviewScript = path.resolve(__dirname, '../scripts/generate_review.js');
const serverScript = path.resolve(__dirname, '../scripts/review_server.js');

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      finish();
    }, 1500);
    timeout.unref();
  });
}

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

async function openChrome(url, profileDir) {
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 250 && !fs.existsSync(portFile); attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome 提前退出 ${child.exitCode}: ${stderr}`);
    await delay(20);
  }
  if (!fs.existsSync(portFile)) throw new Error(`Chrome DevTools 启动超时: ${stderr}`);
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  return {
    child,
    socket,
    evaluate,
    async close() {
      socket.close();
      await stopChild(child);
    },
  };
}

test('Phase 3 浏览器当前 plan、编辑事务与后台播放', {timeout:60000}, async t => {
  assert.equal(fs.existsSync(CHROME), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-workbench-'));
  let server, chrome;
  t.after(async () => {
    if (chrome) await chrome.close();
    if (server) await stopChild(server);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const source = makeMarkerWav(root, { duration: 1.5 });
  const transcribeDir = path.join(root, '1_转录');
  const reviewDir = path.join(root, '3_审核');
  const wordsFile = path.join(root, 'words.json');
  const breaksFile = path.join(root, 'breaks.json');
  const selectedFile = path.join(root, 'selected.json');
  const words = [
    { id: 'word-000000', text: '开头', startSample: 4800, endSample: 9600 },
    { id: 'word-000001', text: '删除', startSample: 36000, endSample: 40800 },
    { id: 'word-000002', text: '结尾', startSample: 62400, endSample: 67200 },
  ];
  const asrBreaks = [
    { id: 'asr-break-fixture', previousWordId: 'word-000000', nextWordId: 'word-000001', startSample: 9600, endSample: 36000 },
  ];
  fs.writeFileSync(wordsFile, JSON.stringify(words));
  fs.writeFileSync(breaksFile, JSON.stringify(asrBreaks));
  fs.writeFileSync(selectedFile, JSON.stringify({ wordIds: ['word-000001'] }));
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
  const contextFile = path.join(transcribeDir, 'media_context.json');
  execFileSync(process.execPath, [
    generateReviewScript,
    wordsFile,
    breaksFile,
    selectedFile,
    contextFile,
    reviewDir,
  ]);

  const dataPath = path.join(reviewDir, 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  data.mediaContext.offsets.playerPresentationOffset = { seconds: 0.05, status: 'verified' };
  fs.writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(contextFile, `${JSON.stringify(data.mediaContext, null, 2)}\n`);

  const port = await freePort();
  server = spawn(process.execPath, [serverScript, String(port), contextFile], {
    cwd: reviewDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitUntilReady(server);

  chrome = await openChrome(`http://127.0.0.1:${port}/`, path.join(root, 'chrome-profile'));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await chrome.evaluate(`JSON.stringify({
      ready: !!window.__reviewTest?.ready,
      error: window.__reviewTest?.error || null
    })`);
    const parsed = JSON.parse(state);
    if (parsed.error) assert.fail(parsed.error);
    if (parsed.ready) break;
    if (attempt === 499) assert.fail('工作台初始化超时');
    await delay(20);
  }


  async function reload() {
    await chrome.evaluate('location.reload()');
    await delay(100);
    for (let i=0;i<500;i++) {
      const status=await chrome.evaluate('({ready:!!window.__reviewTest?.ready,error:window.__reviewTest?.error})');
      if (status.error) assert.fail(status.error);
      if (status.ready) return;
      await delay(20);
    }
    assert.fail('reload timeout: '+await chrome.evaluate('document.body.innerText.slice(0,500)'));
  }
  await t.test('padding undo/redo 同步控件，另一控件不会回写旧值', async () => {
    const result = await chrome.evaluate(`(() => {
      const api=__reviewTest, a=document.getElementById('knob-padstart'), b=document.getElementById('knob-padend');
      const initial=api.getEditState();
      a.value='6'; a.dispatchEvent(new Event('input'));
      const changed=api.getEditState(); a.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyZ',ctrlKey:true,bubbles:true}));
      const afterUndo={state:api.getEditState(), value:a.value, label:document.getElementById('knob-padstart-val').textContent};
      a.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyZ',ctrlKey:true,shiftKey:true,bubbles:true}));
      const afterRedo={state:api.getEditState(),value:a.value};
      api.undo(); b.value='4'; b.dispatchEvent(new Event('input'));
      const player=document.getElementById('player'), playbackBefore=player.currentTime;
      const arrow=new KeyboardEvent('keydown',{code:'ArrowRight',bubbles:true,cancelable:true});
      b.dispatchEvent(arrow);
      return {initial,changed,afterUndo,afterRedo,final:api.getEditState(),ready:api.ready,
        arrowIntercepted:arrow.defaultPrevented,playbackBefore,playbackAfter:player.currentTime};
    })()`);
    assert.equal(result.afterUndo.value,'2');
    assert.equal(result.afterUndo.label,'2 帧');
    assert.deepEqual(result.afterUndo.state,result.initial);
    assert.deepEqual(result.afterRedo.state,result.changed);
    assert.equal(result.afterRedo.value,'6');
    assert.equal(result.final.policy.silencePaddingStartSamples,result.initial.policy.silencePaddingStartSamples);
    assert.equal(result.final.policy.silencePaddingEndSamples,6400);
    assert.equal(result.ready,true);
    assert.equal(result.arrowIntercepted,false);
    assert.equal(result.playbackAfter,result.playbackBefore);
  });
  await reload();
  await t.test('编译或编辑失败保留已提交 state/plan/history/UI 并允许修复后继续',async () => {
    const result=await chrome.evaluate(`(() => {
      const api=__reviewTest, before={state:api.getEditState(),plan:JSON.stringify(api.getPlan()),revision:api.getConsumerConsistency().revision};
      const compile=CompileEdit.compileEdit;
      CompileEdit.compileEdit=()=>{throw new Error('transient compilation fixture');};
      try{api.dispatch({type:'DELETE_WORD',wordId:'word-000000'});}catch(_){}
      const slider=document.getElementById('knob-padstart');
      slider.value='8'; slider.dispatchEvent(new Event('input'));
      const revertedControl=slider.value;
      CompileEdit.compileEdit=compile;
      const failed={state:api.getEditState(),plan:JSON.stringify(api.getPlan()),revision:api.getConsumerConsistency().revision,ready:api.ready};
      api.dispatch({type:'DELETE_WORD',wordId:'word-000000'}); api.undo();
      const recovered={state:api.getEditState(),ready:api.ready};
      try{api.dispatch({type:'DELETE_WORD',wordId:'unknown'});}catch(_){}
      const invalid={state:api.getEditState(),ready:api.ready};
      return {before,failed,recovered,invalid,revertedControl,consistent:api.getConsumerConsistency().sameObject};
    })()`);
    assert.deepEqual(result.failed.state,result.before.state);
    assert.equal(result.failed.plan,result.before.plan);
    assert.equal(result.failed.revision,result.before.revision);
    assert.equal(result.failed.ready,true);
    assert.equal(result.revertedControl,'2');
    assert.deepEqual(result.recovered.state,result.before.state);
    assert.deepEqual(result.invalid.state,result.before.state);
    assert.equal(result.invalid.ready,true);
    assert.equal(result.consistent,true);
  });
  await reload();
  await t.test('plan 切换取消旧 seek/preview，短 cut 跨越仍执行',async () => {
    const result=await chrome.evaluate(`(() => {
      const api=__reviewTest;
      api.dispatch({type:'SET_POLICY',patch:{autoSilenceEnabled:false}});
      api.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{startSample:5000,endSample:5001}});
      api.resetSeekProbe();
      const before=api.processPlaybackSample(4999,false);
      const crossed=api.processPlaybackSample(5002,false);
      api.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{startSample:6000,endSample:6100}});
      const next=api.processPlaybackSample(6050,false);
      api.beginPreview({startSample:0,endSample:1000});
      api.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{startSample:7000,endSample:7100}});
      const afterPreview=api.processPlaybackSample(7050,false);
      return {before,crossed,next,afterPreview};
    })()`);
    assert.equal(result.before,null);
    assert.equal(result.crossed,5001);
    assert.equal(result.next,6100);
    assert.equal(result.afterPreview,7100);
  });
  await reload();
  await t.test('PCM 标签只撤销自身来源，不能认领另一标签的重叠手工删除', async () => {
    const result=await chrome.evaluate(`(() => {
      const api=__reviewTest;
      api.dispatch({type:'SET_POLICY',patch:{autoSilenceEnabled:false}});
      const nodes=[...document.querySelectorAll('[data-silence-id]')], node=nodes[0];
      const foreign={startSample:Number(node.dataset.startSample)-100,endSample:Number(node.dataset.endSample),sourceSilenceId:nodes[1].dataset.silenceId};
      api.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:foreign,sourceSilenceId:foreign.sourceSilenceId});
      const before=api.getEditState(); node.click();
      return {foreign,before,after:api.getEditState(),outsideAudible:api.isReviewSampleAudible(foreign.startSample)};
    })()`);
    assert.deepEqual(result.after.manualDeleteRanges,result.before.manualDeleteRanges);
    assert.equal(result.outsideAudible,false);
  });
  await reload();
  await t.test('临时写入错误不会判死页面，恢复后可用同一session导出', async () => {
    const exportsDir=path.join(reviewDir,'exports');
    fs.writeFileSync(exportsDir,'temporary obstruction');
    const failed=await chrome.evaluate(`(async()=>{ window.alert=()=>{}; const result=await __reviewTest.requestExport(); return {result,ready:__reviewTest.ready,error:__reviewTest.error,disabled:document.getElementById('exportButton').disabled}; })()`);
    assert.equal(failed.result,null);
    assert.equal(failed.ready,true);
    assert.equal(failed.error,null);
    assert.equal(failed.disabled,false);
    fs.unlinkSync(exportsDir);
    const success=await chrome.evaluate('window.__reviewTest.requestExport()');
    assert.ok(success.revision);
    assert.equal(success.downloadUrl,`/api/download/fcpxml/${success.revision}`);
    assert.equal(fs.existsSync(success.output),true);
    assert.equal(path.dirname(success.output),path.dirname(success.learningDiff));
  });
  await reload();
  await t.test('后台暂停媒体；返回前台不自动播放',async () => {
    const result=await chrome.evaluate(`(async () => {
      const player=document.getElementById('player'); player.muted=true;
      await player.play();
      const started=!player.paused;
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
      const hiddenPaused=player.paused;
      Object.defineProperty(document,'hidden',{configurable:true,value:false});
      document.dispatchEvent(new Event('visibilitychange'));
      return {started,hiddenPaused,visiblePaused:player.paused};
    })()`);
    assert.equal(result.started,true);
    assert.equal(result.hiddenPaused,true);
    assert.equal(result.visiblePaused,true);
  });
});
