'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const serverScript = path.resolve(__dirname, '../scripts/review_server.js');

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
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY_PORT=')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`审核服务器提前退出: ${code}\n${output}`));
    });
  });
}

test('审核接口按 includeTitles 开关导出或省略可编辑标题字幕', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-server-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const audioFile = path.join(tempDir, 'speech.wav');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
    '-c:a', 'pcm_s16le', audioFile,
  ]);
  fs.writeFileSync(path.join(tempDir, 'data.json'), JSON.stringify({
    words: [
      { text: '保留字幕', start: 0.1, end: 0.8, isGap: false },
      { text: '', start: 0.8, end: 1.2, isGap: true },
      { text: '删除字幕', start: 1.2, end: 1.8, isGap: false },
      { text: '', start: 1.8, end: 2.2, isGap: true },
      { text: '后段字幕', start: 2.2, end: 2.8, isGap: false },
    ],
    autoSelected: [],
  }));
  fs.writeFileSync(path.join(tempDir, 'silence_periods.json'), '[]');

  const port = await freePort();
  const child = spawn(process.execPath, [serverScript, String(port), audioFile], {
    cwd: tempDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitUntilReady(child);

  const sharedModule = await fetch(`http://127.0.0.1:${port}/lib/subtitle_blocks.js`);
  assert.equal(sharedModule.status, 200);
  assert.match(sharedModule.headers.get('content-type') || '', /javascript/);

  const request = async includeTitles => {
    const response = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        includeTitles,
        deleteList: [{ start: 1, end: 2 }],
        finalSelected: [2],
        opts: { mergeGap: 0, minKeepDur: 0.01, lookBack: 0, padStart: 0, padEnd: 0, minInternalSilence: 99 },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    return { xml: fs.readFileSync(result.output, 'utf8'), output: result.output };
  };

  const withTitles = await request(true);
  assert.match(withTitles.xml, /<title [^>]*lane="1"/);
  assert.match(withTitles.xml, /保留字幕/);
  assert.doesNotMatch(withTitles.xml, /删除字幕/);

  const fcpDtd = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_8.dtd';
  if (fs.existsSync(fcpDtd)) {
    execFileSync('xmllint', ['--noout', '--dtdvalid', pathToFileURL(fcpDtd).href, withTitles.output]);
  }

  const withoutTitles = await request(false);
  assert.doesNotMatch(withoutTitles.xml, /<title /);
  assert.doesNotMatch(withoutTitles.xml, /<effect id="r3"/);
});
