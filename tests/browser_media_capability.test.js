'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeAudio, makeCfrVideo } = require('./helpers/media_fixtures');
const { delay, openChrome } = require('./helpers/browser_session');

const scripts = path.resolve(__dirname, '../scripts');

function prepareReview(dir, source) {
  const transcribe = path.join(dir, 'transcribe');
  const review = path.join(dir, 'review');
  fs.mkdirSync(review);
  execFileSync(process.execPath, [path.join(scripts, 'prepare_media.js'), source, transcribe]);
  const words = path.join(dir, 'words.json');
  const breaks = path.join(dir, 'breaks.json');
  const selected = path.join(dir, 'selected.json');
  fs.writeFileSync(words, JSON.stringify([{ id: 'word-0', text: '合成', startSample: 4800, endSample: 9600 }]));
  fs.writeFileSync(breaks, '[]');
  fs.writeFileSync(selected, '{"wordIds":[]}');
  execFileSync(process.execPath, [
    path.join(scripts, 'generate_review.js'), words, breaks, selected,
    path.join(transcribe, 'media_context.json'), review,
  ]);
  const context = JSON.parse(fs.readFileSync(path.join(transcribe, 'media_context.json'), 'utf8'));
  return { review, context };
}

function stream(response, request, file, contentType) {
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  response.writeHead(range ? 206 : 200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  fs.createReadStream(file, { start, end }).pipe(response);
}

async function state(chrome) {
  return chrome.evaluate(`({ready: !!window.__reviewTest?.ready,
    error: window.__reviewTest?.error || null,
    disabled: document.getElementById('exportButton')?.disabled,
    hasData: document.querySelectorAll('[data-word-id]').length > 0})`);
}

async function waitForState(chrome) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await state(chrome);
    if (value.ready || value.error) return value;
    await delay(20);
  }
  throw new Error('浏览器能力 gate 未返回结果');
}

test('real browser with localhost media gates review readiness and permanently blocks media failures', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roughcut-browser-capability-'));
  let chrome;
  let server;
  t.after(async () => {
    if (chrome) await chrome.close();
    if (server) { server.closeAllConnections(); server.close(); }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const audioDir = path.join(root, 'audio');
  const videoDir = path.join(root, 'video');
  const unsupportedDir = path.join(root, 'unsupported');
  fs.mkdirSync(audioDir);
  fs.mkdirSync(videoDir);
  fs.mkdirSync(unsupportedDir);
  const audio = prepareReview(audioDir, makeAudio(audioDir, 'wav'));
  const video = prepareReview(videoDir, makeCfrVideo(videoDir, 'mp4'));
  const unsupportedSource = path.join(unsupportedDir, 'source.mov');
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', video.context.sourcePath, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', '-y', unsupportedSource,
  ]);
  const unsupported = prepareReview(unsupportedDir, unsupportedSource);
  let fixture = audio;
  let holdMedia = true;
  let requestCount = 0;
  const held = [];
  const serveMedia = (request, response) => stream(response, request, fixture.context.playbackPath,
    fixture.context.mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4');
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/video') {
      requestCount += 1;
      if (holdMedia) held.push([request, response]);
      else serveMedia(request, response);
      return;
    }
    if (url.pathname === '/broken') {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end('invalid media');
      return;
    }
    let file;
    if (url.pathname.startsWith('/lib/')) file = path.join(scripts, url.pathname);
    else file = path.join(fixture.review, url.pathname === '/' ? 'review.html' : url.pathname);
    if (!fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript' });
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  chrome = await openChrome(url, path.join(root, 'chrome'));

  await t.test('media still loading cannot open review or export', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (requestCount && await chrome.evaluate('!!window.__reviewTest')) break;
      await delay(20);
    }
    await delay(100);
    const value = await state(chrome);
    holdMedia = false;
    for (const [request, response] of held) if (!response.destroyed) serveMedia(request, response);
    assert.equal(value.ready, false);
    assert.equal(value.disabled, true);
    assert.equal(await chrome.evaluate("[...document.querySelectorAll('.topbar,.workspace')].every(node => node.inert)"), true);
  });

  await t.test('unified MP3 passes actual decode and seek checks', async () => {
    const value = await waitForState(chrome);
    assert.equal(value.error, null);
    assert.equal(value.ready, true);
    assert.equal(value.disabled, false);
  });

  await t.test('decode failure after readiness blocks export and cannot be cleared by editing', async () => {
    await chrome.evaluate("__reviewTest.dispatch({type:'DELETE_WORD',wordId:'word-0'})");
    await chrome.evaluate("document.getElementById('player').src='/broken'");
    for (let attempt = 0; attempt < 200 && !(await state(chrome)).error; attempt += 1) await delay(20);
    const failed = await state(chrome);
    assert.match(failed.error || '', /浏览器.*格式|解码失败/);
    assert.equal(failed.ready, false);
    assert.equal(failed.disabled, true);
    const before = await chrome.evaluate('__reviewTest.getEditState()');
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4 });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 0 });
    assert.deepEqual(await chrome.evaluate('__reviewTest.getEditState()'), before);
    assert.equal(await chrome.evaluate("[...document.querySelectorAll('.topbar,.workspace')].every(node => node.inert)"), true);
    assert.equal((await state(chrome)).disabled, true);
  });

  await t.test('original H.264 AAC CFR video passes actual decode and seek checks', async () => {
    fixture = video;
    await chrome.evaluate(`location.href=${JSON.stringify(url + '?video')}`);
    await delay(50);
    const value = await waitForState(chrome);
    assert.equal(value.error, null);
    assert.equal(value.ready, true);
    assert.equal(await chrome.evaluate("document.getElementById('player').videoWidth"), 160);
  });

  await t.test('legal CFR with unverified browser codecs is explicitly blocked before review', async () => {
    fixture = unsupported;
    await chrome.evaluate(`location.href=${JSON.stringify(url + '?unsupported')}`);
    await delay(50);
    const value = await waitForState(chrome);
    assert.equal(value.ready, false);
    assert.equal(value.disabled, true);
    assert.match(value.error, /编码.*prores.*pcm_s16le/);
  });
});
