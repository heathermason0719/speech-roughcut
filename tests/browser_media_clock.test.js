'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeCfrVideo, makeMarkerWav } = require('./helpers/media_fixtures');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');

function browserFixtureHtml(markers, { tag = 'audio', endpoint = '/audio' } = {}) {
  return `<!doctype html>
<meta charset="utf-8">
<${tag} id="media" preload="auto" src="${endpoint}"></${tag}>
<pre id="result">pending</pre>
<script>
(async () => {
  const markers = ${JSON.stringify(markers)};
  const media = document.getElementById('media');
  const resultNode = document.getElementById('result');
  const mark = step => { resultNode.textContent = JSON.stringify({ ok: false, step }); };
  mark('script-started');
  const context = new AudioContext({ sampleRate: 48000 });
  const source = context.createMediaElementSource(media);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const once = name => new Promise(resolve => media.addEventListener(name, resolve, { once: true }));
  await context.resume();
  mark('context-resumed');
  const measured = [];
  for (const marker of markers) {
    media.pause();
    mark('before-seek-' + marker);
    media.currentTime = Math.max(0, marker - 0.06);
    await once('seeked');
    mark('after-seek-' + marker);
    await media.play();
    mark('playing-' + marker);
    let detected = null;
    const deadline = marker + 0.08;
    while (media.currentTime <= deadline) {
      if (media.currentTime < marker - 0.02) {
        await wait(2);
        continue;
      }
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      const rms = Math.sqrt(sum / samples.length);
      mark('scan-' + marker + '-time-' + media.currentTime.toFixed(4) + '-rms-' + rms.toFixed(4));
      if (rms >= 0.08) { detected = media.currentTime; break; }
      await wait(2);
    }
    media.pause();
    if (detected === null) throw new Error('marker not audible at ' + marker);
    measured.push(detected - marker);
  }
  const payload = {
    ok: true,
    htmlMediaElement: media instanceof HTMLMediaElement,
    mediaElementSource: source instanceof MediaElementAudioSourceNode,
    analyserNode: analyser instanceof AnalyserNode,
    audioContextLatency: {
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency || 0,
      analyserWindow: analyser.fftSize / context.sampleRate,
    },
    measured,
  };
  resultNode.textContent = JSON.stringify(payload);
  await context.close();
})().catch(error => {
  document.getElementById('result').textContent = JSON.stringify({ ok: false, error: error.message });
});
</script>`;
}

function streamMedia(request, response, filePath, contentType) {
  const stat = fs.statSync(filePath);
  const match = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
  if (request.headers.range && !match) {
    response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    response.end();
    return;
  }
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    response.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(response);
}

function assertClockResult(result, { compensateAudioOutputLatency = true } = {}) {
  assert.equal(result.ok, true, result.error || result.step);
  assert.equal(result.htmlMediaElement, true);
  assert.equal(result.mediaElementSource, true);
  assert.equal(result.analyserNode, true);
  assert.equal(result.measured.length, 3);
  const observationLatency = result.audioContextLatency.baseLatency
    + result.audioContextLatency.outputLatency;
  const correctedOffsets = result.measured.map(value => (
    compensateAudioOutputLatency ? value - observationLatency : value
  ));
  const minimum = Math.min(...correctedOffsets);
  const maximum = Math.max(...correctedOffsets);
  assert.ok(maximum - minimum <= 480 / 48000, JSON.stringify(result.measured));
  assert.ok(
    Math.abs(correctedOffsets.slice().sort((a, b) => a - b)[1]) <= 480 / 48000,
    JSON.stringify({ ...result, correctedOffsets }),
  );
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runChrome(url, profileDir) {
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
  try {
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 250 && !fs.existsSync(portFile); attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Chrome 提前退出 ${child.exitCode}: ${stderr}`);
      await delay(20);
    }
    if (!fs.existsSync(portFile)) throw new Error(`Chrome DevTools 启动超时: ${stderr}`);
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(item => item.type === 'page');
    if (!target) throw new Error('Chrome 没有可用 page target');
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
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    let lastValue = 'pending';
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const evaluated = await send('Runtime.evaluate', {
        expression: "document.getElementById('result')?.textContent || 'pending'",
        returnByValue: true,
      });
      lastValue = evaluated.result.value;
      try {
        const parsed = JSON.parse(lastValue);
        if (parsed.ok === true || parsed.error) {
          socket.close();
          return lastValue;
        }
      } catch (_) {
        // 页面尚未进入结构化结果阶段。
      }
      await delay(20);
    }
    socket.close();
    throw new Error(`浏览器声学夹具超时，最后状态: ${lastValue}`);
  } finally {
    child.kill('SIGTERM');
  }
}

test('headless Chrome 用真实媒体元素和音频分析节点验证三点固定 player offset', { timeout: 20000 }, async (t) => {
  assert.equal(fs.existsSync(CHROME), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-browser-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = [0.1, 0.7, 1.3];
  const source = makeMarkerWav(root, { duration: 1.5, markers });
  const transcribeDir = path.join(root, '1_转录');
  const review = execFileSync(process.execPath, [prepareScript, source, transcribeDir], {
    encoding: 'utf8',
  }).trim();
  const html = browserFixtureHtml(markers);
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (request.url === '/audio') {
      streamMedia(request, response, review, 'audio/mpeg');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => server.close());

  const port = server.address().port;
  const serialized = await runChrome(
    `http://127.0.0.1:${port}/fixture`,
    path.join(root, 'chrome-profile'),
  );
  const result = JSON.parse(serialized);
  assertClockResult(result);
});

test('headless Chrome 直接播放原始 CFR 视频并验证三点固定 player offset', { timeout: 30000 }, async (t) => {
  assert.equal(fs.existsSync(CHROME), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-browser-video-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = [0.1, 0.7, 1.3];
  const source = makeCfrVideo(root, 'mp4', { duration: 1.5, markers });
  const transcribeDir = path.join(root, '1_转录');
  execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
  const context = JSON.parse(fs.readFileSync(path.join(transcribeDir, 'media_context.json'), 'utf8'));
  assert.equal(context.playbackPath, path.resolve(source));
  assert.deepEqual(context.offsets.playerPresentationOffset, { seconds: 0, status: 'verified' });
  const html = browserFixtureHtml(markers, { tag: 'video', endpoint: '/media' });
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (request.url === '/media') {
      streamMedia(request, response, source, 'video/mp4');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => server.close());

  const serialized = await runChrome(
    `http://127.0.0.1:${server.address().port}/fixture`,
    path.join(root, 'chrome-profile'),
  );
  assertClockResult(JSON.parse(serialized), { compensateAudioOutputLatency: false });
});
