'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-volc-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(responses));
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_VOLC_ROOT;
const args = process.argv.slice(2);
const calls = path.join(root, 'calls.jsonl');
const index = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
const response = JSON.parse(fs.readFileSync(path.join(root, 'responses.json')))[index];
if (!response) process.exit(99);
if (response.block) { fs.writeFileSync(path.join(root, 'started'), String(process.pid)); setInterval(() => {}, 1000); }
else {
  fs.writeFileSync(args[args.indexOf('-D') + 1], 'HTTP/1.1 ' + (response.http || 200) + ' OK\\r\\nX-Api-Status-Code: ' + (response.status || '20000000') + '\\r\\nX-Tt-Logid: log-123\\r\\n\\r\\n');
  fs.writeFileSync(args[args.indexOf('-o') + 1], typeof response.body === 'string' ? response.body : JSON.stringify(response.body || {}));
  process.stdout.write(String(response.http || 200));
  process.exit(response.exit || 0);
}
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldRoot = process.env.FAKE_VOLC_ROOT;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_VOLC_ROOT = root;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldRoot === undefined) delete process.env.FAKE_VOLC_ROOT;
    else process.env.FAKE_VOLC_ROOT = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const audioPath = path.join(root, 'audio.mp3');
  fs.writeFileSync(audioPath, 'fake audio');
  const options = { engine: 'v3-standard', audioPath, workDir: path.join(root, 'work'), invocationId: 'invocation-a', reviewFingerprint: 'review-a', apiKey: 'secret-test-key', pollIntervalMs: 0, maxAttempts: 1 };
  const run = extra => require('../scripts/lib/volc_task').transcribeVolc({ ...options, ...extra });
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const checkpoint = () => JSON.parse(fs.readFileSync(path.join(options.workDir, 'task.json')));
  return { root, options, run, calls, checkpoint };
}

test('accepted standard task resumes by querying the same identity, then replays without network', async t => {
  const f = fixture(t, [{}, { status: '20000001' }, { body: { result: { text: 'hello' } } }]);
  await assert.rejects(f.run(), /poll|pending|未完成/i);
  const raw = await f.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(raw)), { result: { text: 'hello' } });
  assert.equal(await f.run(), raw);
  const calls = f.calls();
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(args => args.some(arg => arg.endsWith('/submit'))).length, 1);
  assert.deepEqual(calls.map(args => args.find(arg => arg.startsWith('X-Api-Request-Id:'))), Array(3).fill(calls[0].find(arg => arg.startsWith('X-Api-Request-Id:'))));
  assert.ok(calls[2].includes('X-Tt-Logid: log-123'));
  assert.ok(!JSON.stringify(f.checkpoint()).includes('secret-test-key'));
});

test('uncertain submit can only resume a standard query', async t => {
  const f = fixture(t, [{ exit: 28 }, { body: { result: { text: 'ok' } } }]);
  await assert.rejects(f.run(), /uncertain|不确定/i);
  await f.run();
  assert.ok(f.calls()[1].some(arg => arg.endsWith('/query')));
});

test('uncertain flash refuses automatic resend', async t => {
  const f = fixture(t, [{ exit: 28 }]);
  await assert.rejects(f.run({ engine: 'flash' }), /uncertain|不确定/i);
  await assert.rejects(f.run({ engine: 'flash' }), /new invocation|新.*invocation/i);
  assert.equal(f.calls().length, 1);
});

for (const response of [{ http: 503, body: { result: { text: 'bad' } } }, { body: '{"result":' }, { status: '45000003', body: { error: 'bad' } }, { body: [] }, { body: { result: { text: 'bad' } }, exit: 18 }]) {
  test(`does not publish flash raw on invalid response ${JSON.stringify(response)}`, async t => {
    const f = fixture(t, [response]);
    await assert.rejects(f.run({ engine: 'flash' }));
    assert.equal(fs.existsSync(path.join(f.options.workDir, 'raw_result.json')), false);
    await assert.rejects(f.run({ engine: 'flash' }));
    assert.equal(f.calls().length, 1);
  });
}

test('raw replay rejects changed ownership and altered raw bytes', async t => {
  const f = fixture(t, [{ body: { result: { text: 'ok' } } }]);
  const raw = await f.run({ engine: 'flash' });
  await assert.rejects(f.run({ engine: 'flash', invocationId: 'other' }), /ownership|归属/i);
  fs.writeFileSync(raw, JSON.stringify({ result: { text: 'modified' } }));
  await assert.rejects(f.run({ engine: 'flash' }), /digest|摘要/i);
  assert.equal(f.calls().length, 1);
});

test('new processes resume an accepted task without a second submit', t => {
  const f = fixture(t, [{}, { status: '20000002' }, { body: { result: { text: 'after restart' } } }]);
  const program = `require(${JSON.stringify(path.resolve(__dirname, '../scripts/lib/volc_task'))}).transcribeVolc(${JSON.stringify(f.options)}).catch(() => { process.exitCode = 1; });`;
  assert.equal(spawnSync(process.execPath, ['-e', program], { env: process.env }).status, 1);
  assert.equal(spawnSync(process.execPath, ['-e', program], { env: process.env }).status, 0);
  assert.equal(f.calls().filter(args => args.some(arg => arg.endsWith('/submit'))).length, 1);
});

test('failure persisting initial intent sends no network request', async t => {
  const f = fixture(t, []);
  const rename = fs.renameSync;
  fs.renameSync = function (source, dest) {
    if (dest === path.join(f.options.workDir, 'task.json')) throw new Error('injected initial disk failure');
    return rename.apply(this, arguments);
  };
  try { await assert.rejects(f.run(), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.calls().length, 0);
  assert.deepEqual(fs.readdirSync(f.options.workDir), []);
});

test('failure after raw rename still permits verified replay without a key', async t => {
  const f = fixture(t, [{ body: { result: { text: 'saved' } } }]);
  const rename = fs.renameSync;
  fs.renameSync = function (source, dest) {
    if (dest === path.join(f.options.workDir, 'task.json') && JSON.parse(fs.readFileSync(source)).status === 'complete') throw new Error('injected completion disk failure');
    return rename.apply(this, arguments);
  };
  try { await assert.rejects(f.run({ engine: 'flash' }), /disk failure/); }
  finally { fs.renameSync = rename; }
  const raw = await f.run({ engine: 'flash', apiKey: undefined });
  assert.equal(require('../scripts/lib/volc_task').getCompletedRaw({ ...f.options, engine: 'flash', apiKey: undefined }), raw);
  assert.equal(f.calls().length, 1);
  assert.deepEqual(fs.readdirSync(f.options.workDir).sort(), ['raw_result.json', 'task.json']);
});

test('raw rename failure leaves flash unrepeated and no partial raw', async t => {
  const f = fixture(t, [{ body: { result: { text: 'saved' } } }]);
  const rename = fs.renameSync;
  fs.renameSync = function (source, dest) {
    if (dest === path.join(f.options.workDir, 'raw_result.json')) throw new Error('injected raw disk failure');
    return rename.apply(this, arguments);
  };
  try { await assert.rejects(f.run({ engine: 'flash' }), /disk failure/); }
  finally { fs.renameSync = rename; }
  await assert.rejects(f.run({ engine: 'flash' }), /new invocation/);
  assert.equal(f.calls().length, 1);
  assert.deepEqual(fs.readdirSync(f.options.workDir), ['task.json']);
});

test('query transport failures preserve the existing task identity', async t => {
  const f = fixture(t, [{}, { http: 503 }, { body: '{' }, { body: { result: { text: 'finally' } } }]);
  await assert.rejects(f.run(), /uncertain/);
  await assert.rejects(f.run(), /uncertain/);
  await f.run();
  assert.equal(f.calls().length, 4);
  assert.equal(f.calls().filter(args => args.some(arg => arg.endsWith('/submit'))).length, 1);
});

test('provider terminal failure in query is persistent', async t => {
  const f = fixture(t, [{}, { status: '20000003', body: {} }]);
  await assert.rejects(f.run(), /terminal failure/);
  await assert.rejects(f.run(), /terminal failure/);
  assert.equal(f.calls().length, 2);
  assert.equal(f.checkpoint().providerStatus, '20000003');
});

test('failure persisting accepted state leaves a recoverable submit intent', async t => {
  const f = fixture(t, [{}, { body: { result: { text: 'ok' } } }]);
  const rename = fs.renameSync;
  fs.renameSync = function (source, dest) {
    if (dest === path.join(f.options.workDir, 'task.json') && JSON.parse(fs.readFileSync(source)).status === 'accepted') throw new Error('injected accepted disk failure');
    return rename.apply(this, arguments);
  };
  try { await assert.rejects(f.run(), /disk failure/); }
  finally { fs.renameSync = rename; }
  await f.run();
  assert.equal(f.calls().filter(args => args.some(arg => arg.endsWith('/submit'))).length, 1);
});

test('AbortSignal waits for curl to exit and cleans transient files', async t => {
  const f = fixture(t, [{ block: true }]);
  const controller = new AbortController();
  const pending = f.run({ engine: 'flash', signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  for (let n = 0; n < 100 && !fs.existsSync(path.join(f.root, 'started')); n++) await new Promise(resolve => setTimeout(resolve, 10));
  const pid = Number(fs.readFileSync(path.join(f.root, 'started')));
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(fs.readdirSync(f.options.workDir), ['task.json']);
});
