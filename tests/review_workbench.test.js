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

test('headless Chrome 工作台共用唯一 plan，验证空隙点击、配色切换与 seek 闸门', { timeout: 30000 }, async (t) => {
  assert.equal(fs.existsSync(CHROME), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-workbench-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  const server = spawn(process.execPath, [serverScript, String(port), contextFile], {
    cwd: reviewDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(server));
  await waitUntilReady(server);

  const chrome = await openChrome(`http://127.0.0.1:${port}/`, path.join(root, 'chrome-profile'));
  t.after(() => chrome.close());
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

  const initial = JSON.parse(await chrome.evaluate(`JSON.stringify({
    state: __reviewTest.getEditState(),
    dom: __reviewTest.getDomSeparation(),
    consumers: __reviewTest.getConsumerConsistency(),
    mapForward: __reviewTest.reviewSampleToPlayerSeconds(48000),
    mapBack: __reviewTest.playerSecondsToReviewSample(1.05),
    mediaElements: document.querySelectorAll('audio,video').length
  })`));
  assert.deepEqual(initial.state.currentDeletedWordIds, ['word-000001']);
  assert.equal(initial.dom.asrBreakIds.includes('asr-break-fixture'), true);
  assert.ok(initial.dom.detectedSilenceIds.length > 0);
  assert.equal(initial.dom.overlapIds.length, 0);
  assert.equal(initial.consumers.sameObject, true);
  assert.deepEqual(
    initial.consumers.waveCutTicks,
    initial.consumers.playbackCuts.map(cut => [cut.sourceStartTick, cut.sourceEndTick]),
  );
  assert.equal(initial.state.policy.silencePaddingStartSamples, 3200);
  assert.equal(initial.state.policy.silencePaddingEndSamples, 3200);
  assert.ok(initial.dom.detectedSilenceIds.every(id => id.includes('m35')));
  assert.equal(initial.mediaElements, 1);
  assert.ok(Math.abs(initial.mapForward - 1.05) < 1e-9);
  assert.equal(initial.mapBack, 48000);

  await t.test('PCM 自动删除通过页面点击恢复，再点击重切，阈值切换与撤销保持一致', async () => {
    const result = await chrome.evaluate(`(() => {
      const before = __reviewTest.getPlan();
      const node = [...document.querySelectorAll('[data-silence-id]')]
        .find(item => item.dataset.cutCoverage !== 'none');
      const range = { startSample: Number(node.dataset.startSample), endSample: Number(node.dataset.endSample) };
      const cut = before.cuts.find(item => item.reviewStartSample < range.endSample && item.reviewEndSample > range.startSample);
      const sample = Math.floor((Math.max(range.startSample, cut.reviewStartSample) + Math.min(range.endSample, cut.reviewEndSample)) / 2);
      const silenceId = node.dataset.silenceId;
      const snapshot = () => ({
        audible: __reviewTest.isReviewSampleAudible(sample),
        coverage: document.querySelector('[data-silence-id="' + silenceId + '"]').dataset.cutCoverage,
        state: __reviewTest.getEditState(),
        consumers: __reviewTest.getConsumerConsistency(),
      });
      let actions = 0;
      try {
        node.click(); actions++;
        const restored = snapshot();
        const threshold = document.getElementById('silenceThreshold');
        threshold.value = '-30'; threshold.dispatchEvent(new Event('change', { bubbles: true })); actions++;
        const acrossThreshold = __reviewTest.isReviewSampleAudible(sample);
        threshold.value = '-35'; threshold.dispatchEvent(new Event('change', { bubbles: true })); actions++;
        document.querySelector('[data-silence-id="' + silenceId + '"]').click(); actions++;
        return { before, silenceId, restored, acrossThreshold, recut: snapshot(), after: __reviewTest.getPlan() };
      } finally {
        while (actions-- > 0) __reviewTest.undo();
      }
    })()`);
    assert.equal(result.restored.audible, true);
    assert.equal(result.restored.coverage, 'none');
    assert.ok(result.restored.state.explicitlyRestoredSilenceIds.includes(result.silenceId));
    assert.deepEqual(result.restored.state.manualDeleteRanges, []);
    assert.equal(result.restored.consumers.sameObject, true);
    assert.equal(result.acrossThreshold, true);
    assert.equal(result.recut.audible, false);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(await chrome.evaluate('__reviewTest.getEditState()'), initial.state);
  });

  await t.test('PCM 手动删除也能通过页面恢复和重切，不留下失效删除标记', async () => {
    const result = await chrome.evaluate(`(() => {
      __reviewTest.dispatch({ type: 'SET_POLICY', patch: { autoSilenceEnabled: false } });
      __reviewTest.dispatch({ type: 'RESTORE_WORD', wordId: 'word-000001' });
      let actions = 2;
      try {
        const node = [...document.querySelectorAll('[data-silence-id]')]
          .find(item => item.dataset.cutCoverage === 'none' && Number(item.dataset.endSample) <= 36000);
        const sample = Math.floor((Number(node.dataset.startSample) + Number(node.dataset.endSample)) / 2);
        const snapshot = () => ({
          audible: __reviewTest.isReviewSampleAudible(sample),
          selected: node.classList.contains('selected'),
          coverage: node.dataset.cutCoverage,
        });
        node.click(); actions++; const deleted = snapshot();
        node.click(); actions++; const restored = snapshot();
        node.click(); actions++; const recut = snapshot();
        __reviewTest.dispatch({ type: 'SET_POLICY', patch: { autoSilenceEnabled: true } }); actions++;
        node.click(); actions++; const restoredWithAuto = snapshot();
        node.click(); actions++; const recutWithAuto = snapshot();
        return { deleted, restored, recut, restoredWithAuto, recutWithAuto };
      } finally {
        while (actions-- > 0) __reviewTest.undo();
      }
    })()`);
    assert.deepEqual(result.deleted, { audible: false, selected: true, coverage: 'full' });
    assert.deepEqual(result.restored, { audible: true, selected: false, coverage: 'none' });
    assert.deepEqual(result.recut, result.deleted);
    assert.deepEqual(result.restoredWithAuto, result.restored);
    assert.equal(result.recutWithAuto.audible, false);
    assert.deepEqual(await chrome.evaluate('__reviewTest.getEditState()'), initial.state);
  });

  await t.test('配色下拉改变实际 Canvas 像素和图例，不改变剪辑计划或播放位置', async () => {
    const result = await chrome.evaluate(`(() => {
      const select = document.getElementById('themeSelect');
      const beforePlan = JSON.stringify(__reviewTest.getPlan());
      const beforeTime = document.getElementById('player').currentTime;
      const hasColor = (id, rgb) => {
        const canvas = document.getElementById(id);
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2] && pixels[i + 3] === 255) return true;
        }
        return false;
      };
      try {
        return ['cool', 'mint', 'recut', 'cool'].map((key, index) => {
          const waveColors = [[140,160,200], [94,234,212], [168,159,144], [140,160,200]];
          const headColors = [[255,122,77], [251,113,133], [255,122,77], [255,122,77]];
          select.value = key;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return {
            key,
            waveColor: hasColor('waveCanvas', waveColors[index]),
            headColor: hasColor('wavePlayheadCanvas', headColors[index]),
            legend: getComputedStyle(document.getElementById('lg-del')).backgroundColor,
            samePlan: JSON.stringify(__reviewTest.getPlan()) === beforePlan,
            sameTime: document.getElementById('player').currentTime === beforeTime,
          };
        });
      } finally {
        select.value = 'cool';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    for (const item of result) {
      assert.equal(item.waveColor, true, `${item.key}: waveform pixels`);
      assert.equal(item.headColor, true, `${item.key}: playhead pixels`);
      assert.equal(item.samePlan, true);
      assert.equal(item.sameTime, true);
    }
    assert.equal(result[0].legend, 'rgba(248, 113, 113, 0.95)');
    assert.equal(result[1].legend, 'rgba(251, 113, 133, 0.95)');
    assert.equal(result[2].legend, 'rgba(248, 113, 113, 0.92)');
  });

  const initialGapStyle = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const asr = document.querySelector('[data-asr-break-id="asr-break-fixture"]');
    return {
      coverage: asr.dataset.cutCoverage,
      selected: asr.classList.contains('selected'),
      planSelected: asr.classList.contains('plan-selected'),
      partialSelected: asr.classList.contains('partial-selected'),
      borderStyle: getComputedStyle(asr).borderTopStyle,
      title: asr.title,
    };
  })())`));
  assert.equal(initialGapStyle.coverage, 'full');
  assert.equal(initialGapStyle.selected, false);
  assert.equal(initialGapStyle.planSelected, true);
  assert.equal(initialGapStyle.partialSelected, false);
  assert.equal(initialGapStyle.borderStyle, 'solid');
  assert.match(initialGapStyle.title, /整段删除/);

  const partialGapStyle = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    __reviewTest.dispatch({
      type: 'SET_POLICY',
      patch: { autoSilenceEnabled: false },
    });
    const asr = document.querySelector('[data-asr-break-id="asr-break-fixture"]');
    const result = {
      coverage: asr.dataset.cutCoverage,
      selected: asr.classList.contains('selected'),
      planSelected: asr.classList.contains('plan-selected'),
      partialSelected: asr.classList.contains('partial-selected'),
      borderStyle: getComputedStyle(asr).borderTopStyle,
      title: asr.title,
    };
    __reviewTest.undo();
    return result;
  })())`));
  assert.equal(partialGapStyle.coverage, 'partial');
  assert.equal(partialGapStyle.selected, false);
  assert.equal(partialGapStyle.planSelected, false);
  assert.equal(partialGapStyle.partialSelected, true);
  assert.equal(partialGapStyle.borderStyle, 'dashed');
  assert.match(partialGapStyle.title, /部分删除/);

  const continuousDelete = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    __reviewTest.dispatch({
      type: 'SET_POLICY',
      patch: { autoSilenceEnabled: false },
    });
    __reviewTest.dispatch({ type: 'DELETE_WORD', wordId: 'word-000000' });
    const asr = document.querySelector('[data-asr-break-id="asr-break-fixture"]');
    const result = {
      state: __reviewTest.getEditState(),
      gapAudible: __reviewTest.isReviewSampleAudible(20000),
      consumers: __reviewTest.getConsumerConsistency(),
      gapStyle: {
        coverage: asr.dataset.cutCoverage,
        selected: asr.classList.contains('selected'),
        planSelected: asr.classList.contains('plan-selected'),
        partialSelected: asr.classList.contains('partial-selected'),
        textDecorationLine: getComputedStyle(asr).textDecorationLine,
        title: asr.title,
      },
    };
    __reviewTest.undo();
    __reviewTest.undo();
    return result;
  })())`));
  assert.deepEqual(continuousDelete.state.manualDeleteRanges, []);
  assert.equal(continuousDelete.gapAudible, false);
  assert.equal(continuousDelete.consumers.sameObject, true);
  assert.equal(continuousDelete.gapStyle.coverage, 'full');
  assert.equal(continuousDelete.gapStyle.selected, false);
  assert.equal(continuousDelete.gapStyle.planSelected, true);
  assert.equal(continuousDelete.gapStyle.partialSelected, false);
  assert.match(continuousDelete.gapStyle.textDecorationLine, /line-through/);
  assert.match(continuousDelete.gapStyle.title, /整段删除/);

  const gapClicks = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    __reviewTest.dispatch({
      type: 'SET_POLICY',
      patch: { autoSilenceEnabled: false },
    });
    const click = node => node.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      button: 0,
    }));
    const asr = document.querySelector('[data-asr-break-id="asr-break-fixture"]');
    const asrRange = {
      startSample: Number(asr.dataset.startSample),
      endSample: Number(asr.dataset.endSample),
    };
    click(asr);
    const afterAsrDelete = {
      state: __reviewTest.getEditState(),
      selected: asr.classList.contains('selected'),
      planSelected: asr.classList.contains('plan-selected'),
      partialSelected: asr.classList.contains('partial-selected'),
      coverage: asr.dataset.cutCoverage,
      audible: __reviewTest.isReviewSampleAudible(
        Math.floor((asrRange.startSample + asrRange.endSample) / 2),
      ),
    };
    click(asr);
    const afterAsrRestore = {
      state: __reviewTest.getEditState(),
      selected: asr.classList.contains('selected'),
      planSelected: asr.classList.contains('plan-selected'),
      partialSelected: asr.classList.contains('partial-selected'),
      coverage: asr.dataset.cutCoverage,
    };

    __reviewTest.dispatch({
      type: 'SET_POLICY',
      patch: { autoSilenceEnabled: true },
    });
    return { asrRange, afterAsrDelete, afterAsrRestore };
  })())`));
  assert.deepEqual(gapClicks.asrRange, { startSample: 9600, endSample: 36000 });
  assert.deepEqual(gapClicks.afterAsrDelete.state.manualDeleteRanges, [gapClicks.asrRange]);
  assert.equal(gapClicks.afterAsrDelete.selected, true);
  assert.equal(gapClicks.afterAsrDelete.planSelected, false);
  assert.equal(gapClicks.afterAsrDelete.partialSelected, false);
  assert.equal(gapClicks.afterAsrDelete.coverage, 'full');
  assert.equal(gapClicks.afterAsrDelete.audible, false);
  assert.deepEqual(gapClicks.afterAsrRestore.state.manualDeleteRanges, []);
  assert.equal(gapClicks.afterAsrRestore.selected, false);
  assert.equal(gapClicks.afterAsrRestore.planSelected, false);
  assert.equal(gapClicks.afterAsrRestore.partialSelected, true);
  assert.equal(gapClicks.afterAsrRestore.coverage, 'partial');

  const transitions = await chrome.evaluate(`(() => {
    __reviewTest.dispatch({ type: 'DELETE_WORD', wordId: 'word-000000' });
    __reviewTest.dispatch({ type: 'RESTORE_WORD', wordId: 'word-000001' });
    const restored = {
      state: __reviewTest.getEditState(),
      audible: __reviewTest.isReviewSampleAudible(38400),
      consumers: __reviewTest.getConsumerConsistency()
    };
    __reviewTest.undo();
    const undone = __reviewTest.getEditState();
    const silenceId = __reviewTest.getDomSeparation().detectedSilenceIds[0];
    __reviewTest.toggleSilence(silenceId);
    const silenceRestored = __reviewTest.getEditState();
    const restoredRange = silenceRestored.explicitlyRestoredSilenceRanges[0];
    const restoredSample = Math.floor((restoredRange.startSample + restoredRange.endSample) / 2);
    __reviewTest.setSilenceThresholdDb(-30);
    const restoredAcrossThreshold = {
      audible: __reviewTest.isReviewSampleAudible(restoredSample),
      state: __reviewTest.getEditState(),
      ids: __reviewTest.getDomSeparation().detectedSilenceIds
    };
    __reviewTest.undo();
    const thresholdUndo = {
      state: __reviewTest.getEditState(),
      ids: __reviewTest.getDomSeparation().detectedSilenceIds,
      value: document.getElementById('silenceThreshold').value
    };
    __reviewTest.undo();
    __reviewTest.setSilenceThresholdDb(-30);
    const looseThreshold = {
      ids: __reviewTest.getDomSeparation().detectedSilenceIds,
      value: document.getElementById('silenceThreshold').value
    };
    __reviewTest.setSilenceThresholdDb(-45);
    const strictThreshold = {
      ids: __reviewTest.getDomSeparation().detectedSilenceIds,
      value: document.getElementById('silenceThreshold').value
    };
    __reviewTest.setSilenceThresholdDb(-35);
    return {
      restored, undone, silenceRestored, silenceId, restoredAcrossThreshold,
      thresholdUndo, looseThreshold, strictThreshold
    };
  })()`);
  assert.deepEqual(transitions.restored.state.currentDeletedWordIds, ['word-000000']);
  assert.deepEqual(transitions.restored.state.explicitlyRestoredWordIds, ['word-000001']);
  assert.equal(transitions.restored.audible, true);
  assert.equal(transitions.restored.consumers.sameObject, true);
  assert.deepEqual(transitions.undone.currentDeletedWordIds, ['word-000000', 'word-000001']);
  assert.equal(transitions.silenceRestored.explicitlyRestoredSilenceIds.includes(transitions.silenceId), true);
  assert.equal(transitions.silenceRestored.explicitlyRestoredSilenceRanges.length, 1);
  assert.equal(transitions.restoredAcrossThreshold.audible, true);
  assert.equal(transitions.restoredAcrossThreshold.state.policy.silenceThresholdDb, -30);
  assert.ok(transitions.restoredAcrossThreshold.ids.every(id => id.includes('m30')));
  assert.equal(transitions.thresholdUndo.state.policy.silenceThresholdDb, -35);
  assert.ok(transitions.thresholdUndo.ids.every(id => id.includes('m35')));
  assert.equal(transitions.thresholdUndo.value, '-35');
  assert.ok(transitions.looseThreshold.ids.every(id => id.includes('m30')));
  assert.ok(transitions.strictThreshold.ids.every(id => id.includes('m45')));
  assert.notDeepEqual(transitions.looseThreshold.ids, transitions.strictThreshold.ids);
  assert.equal(transitions.looseThreshold.value, '-30');
  assert.equal(transitions.strictThreshold.value, '-45');

  const playback = await chrome.evaluate(`(async () => {
    const cut = __reviewTest.getPlan().cuts[0];
    const player = document.getElementById('player');
    let seekingEvents = 0;
    let seekedEvents = 0;
    player.addEventListener('seeking', () => { seekingEvents += 1; });
    const realSeeked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native seeked timeout')), 2000);
      player.addEventListener('seeked', () => {
        seekedEvents += 1;
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    __reviewTest.resetSeekProbe();
    __reviewTest.processPlaybackSample(cut.reviewStartSample + 1);
    __reviewTest.processPlaybackSample(cut.reviewStartSample + 2);
    __reviewTest.processPlaybackSample(cut.reviewStartSample + 3);
    const during = __reviewTest.getSeekWrites();
    const pending = __reviewTest.getPendingSeek();
    __reviewTest.processPlaybackSample(cut.reviewEndSample + 1);
    const whilePending = __reviewTest.getSeekWrites();
    await realSeeked;
    const afterNativeSeek = {
      pending: __reviewTest.getPendingSeek(),
      currentTime: player.currentTime,
      seekingEvents,
      seekedEvents
    };
    __reviewTest.beginPreview({ startSample: cut.reviewStartSample, endSample: cut.reviewEndSample });
    __reviewTest.processPlaybackSample(cut.reviewStartSample + 1);
    const preview = __reviewTest.getSeekWrites();
    __reviewTest.endPreview();
    return { cut, during, pending, whilePending, afterNativeSeek, preview };
  })()`);
  assert.equal(playback.during[playback.cut.id], 1);
  assert.equal(playback.pending.cutId, playback.cut.id);
  assert.equal(playback.pending.targetSample, playback.cut.reviewEndSample);
  assert.equal(playback.whilePending[playback.cut.id], 1);
  assert.equal(playback.afterNativeSeek.pending, null);
  assert.equal(playback.afterNativeSeek.seekingEvents, 1);
  assert.equal(playback.afterNativeSeek.seekedEvents, 1);
  assert.ok(Math.abs(
    playback.afterNativeSeek.currentTime
      - initial.mapForward
      - (playback.cut.reviewEndSample - 48000) / 48000,
  ) <= 0.02);
  assert.equal(playback.preview[playback.cut.id], 1);

  const visibleConsumers = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const title = __reviewTest.getPlan().titleBlocks.find(item => item.text === '结尾');
    __reviewTest.updatePlayheadForTest(title.reviewStartSample);
    const canvas = document.getElementById('waveCanvas');
    const rectangle = canvas.getBoundingClientRect();
    const slider = document.getElementById('zoomSlider');
    slider.value = '500';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, clientX: rectangle.left + rectangle.width * 0.8
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: rectangle.left + rectangle.width * 0.4
    }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const stage = document.querySelector('.stage').getBoundingClientRect();
    document.getElementById('resizer').dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, clientX: stage.right - 350
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: stage.right - 420
    }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.getElementById('dockResizer').dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, clientY: 500
    }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 450 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const titlePreview = __reviewTest.getTitlePreview();
    const titleConsumers = __reviewTest.getConsumerConsistency();
    const beforeRenderStats = __reviewTest.getWaveRenderStats();
    const viewport = __reviewTest.getWaveViewport();
    for (let index = 0; index < 20; index += 1) {
      __reviewTest.updatePlayheadForTest(
        viewport.startSample + viewport.visibleSamples * (0.2 + index / 200)
      );
    }
    const afterRenderStats = __reviewTest.getWaveRenderStats();
    return {
      title,
      preview: titlePreview,
      consumers: titleConsumers,
      viewport: __reviewTest.getWaveViewport(),
      beforeRenderStats,
      afterRenderStats,
      hasPlayheadOverlay: Boolean(document.getElementById('wavePlayheadCanvas')),
      stageWidth: stage.width,
      sideWidth: document.querySelector('.side-panel').style.width,
      waveHeight: document.documentElement.style.getPropertyValue('--wave-h')
    };
  })())`));
  assert.equal(visibleConsumers.preview.visible, true);
  assert.equal(visibleConsumers.preview.text, '结尾');
  assert.equal(Number(visibleConsumers.preview.outputStartTick), visibleConsumers.title.outputStartTick);
  assert.equal(Number(visibleConsumers.preview.outputEndTick), visibleConsumers.title.outputEndTick);
  assert.deepEqual(visibleConsumers.consumers.visibleTitle, {
    id: visibleConsumers.title.id,
    outputStartTick: visibleConsumers.title.outputStartTick,
    outputEndTick: visibleConsumers.title.outputEndTick,
  });
  assert.deepEqual(
    visibleConsumers.consumers.waveCutTicks,
    visibleConsumers.consumers.playbackCuts.map(cut => [cut.sourceStartTick, cut.sourceEndTick]),
  );
  assert.ok(visibleConsumers.viewport.scale > 1);
  assert.ok(visibleConsumers.viewport.startSample > 0);
  assert.equal(visibleConsumers.hasPlayheadOverlay, true);
  assert.equal(
    visibleConsumers.afterRenderStats.backgroundRenders,
    visibleConsumers.beforeRenderStats.backgroundRenders,
  );
  assert.ok(
    visibleConsumers.afterRenderStats.playheadRenders
      >= visibleConsumers.beforeRenderStats.playheadRenders + 20,
  );
  assert.equal(
    visibleConsumers.sideWidth,
    `${Math.max(300, Math.min(420, visibleConsumers.stageWidth - 360))}px`,
  );
  assert.match(visibleConsumers.waveHeight, /^\d+px$/);

  const exported = await chrome.evaluate(`(async () => {
    window.alert = () => {};
    await __reviewTest.exportNow();
    const payload = __reviewTest.getLastExportPayload();
    return {
      payload,
      consumers: __reviewTest.getConsumerConsistency(),
      exportDisabled: document.getElementById('exportButton').disabled
    };
  })()`);
  assert.ok(exported.payload.compiledCutPlan);
  assert.equal(Object.hasOwn(exported.payload, 'deleteList'), false);
  assert.equal(Object.hasOwn(exported.payload, 'opts'), false);
  assert.equal(exported.consumers.sameObject, true);
  assert.equal(exported.exportDisabled, false);

  const transientFailure = await chrome.evaluate(`(async () => {
    const originalFetch = window.fetch;
    window.fetch = () => Promise.reject(new TypeError('offline fixture'));
    await __reviewTest.requestExport();
    window.fetch = originalFetch;
    return {
      ready: __reviewTest.ready,
      error: __reviewTest.error,
      lastExportError: __reviewTest.lastExportError,
      disabled: document.getElementById('exportButton').disabled
    };
  })()`);
  assert.equal(transientFailure.ready, true);
  assert.equal(transientFailure.error, null);
  assert.match(transientFailure.lastExportError, /offline fixture/);
  assert.equal(transientFailure.disabled, false);

  const failedClosed = await chrome.evaluate(`(() => {
    __reviewTest.replaceMediaContextForTest({
      ...__reviewTest.getMediaContext(),
      timebase: { kind: 'audio-samples', ticksPerSecond: 0 }
    });
    return {
      error: __reviewTest.error,
      disabled: document.getElementById('exportButton').disabled
    };
  })()`);
  assert.match(failedClosed.error, /timebase/);
  assert.equal(failedClosed.disabled, true);
});
