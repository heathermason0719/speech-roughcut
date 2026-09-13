'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function fixture(t, responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(responses));
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.FAKE_ROOT;
const calls = path.join(root, 'calls');
const index = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\\n').length : 0;
const body = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].slice(1)));
fs.appendFileSync(calls, JSON.stringify({ args, body }) + '\\n');
const r = JSON.parse(fs.readFileSync(path.join(root, 'responses.json')))[index];
if (!r) process.exit(99);
if (r.block) { fs.writeFileSync(path.join(root, 'started'), String(process.pid)); setInterval(() => {}, 1000); }
else {
fs.writeFileSync(args[args.indexOf('-D') + 1], 'HTTP/1.1 ' + (r.http || 200) + ' OK\\r\\nX-Api-Status-Code: ' + (r.status || '20000000') + '\\r\\nX-Tt-Logid: cli-log\\r\\n');
fs.writeFileSync(args[args.indexOf('-o') + 1], typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}));
process.stdout.write(String(r.http || 200));
process.exit(r.exit || 0);
}
`, { mode: 0o755 });
  const input = path.join(root, 'input.mp3');
  fs.writeFileSync(input, 'fake audio');
  const out = path.join(root, 'out');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: root, VOLCENGINE_API_KEY: 'fake-cli-key' };
  delete env.SPEECH_ROUGHCUT_LOCKED_BASE;
  delete env.SPEECH_ROUGHCUT_INVOCATION;
  delete env.SPEECH_ROUGHCUT_OWNER;
  const run = (engine = 'flash', extra = [], overrides = {}) => spawnSync('bash', [path.resolve(__dirname, `../scripts/volcengine_${engine === 'flash' ? 'flash' : 'v3'}_transcribe.sh`), input, out, ...extra], { env: { ...env, ...overrides }, encoding: 'utf8' });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, input, out, env, run, calls };
}

test('standalone success requires explicit resume and replays without reading a key', t => {
  const f = fixture(t, [{ body: { result: { text: 'saved' } } }]);
  assert.equal(f.run().status, 0);
  const result = path.join(f.out, 'volcengine_v3_result.json');
  const before = fs.readFileSync(result);
  assert.notEqual(f.run().status, 0);
  assert.equal(f.run('flash', ['--resume'], { VOLCENGINE_API_KEY: 'your_api_key_here' }).status, 0);
  assert.deepEqual(fs.readFileSync(result), before);
  assert.equal(f.calls().length, 1);
});

test('failed response cannot publish or overwrite a standalone result', t => {
  const f = fixture(t, [{ http: 503, body: { result: { text: 'bad' } } }]);
  assert.notEqual(f.run().status, 0);
  const result = path.join(f.out, 'volcengine_v3_result.json');
  assert.equal(fs.existsSync(result), false);
  fs.writeFileSync(result, 'existing bytes');
  assert.notEqual(f.run('flash', ['--resume']).status, 0);
  assert.equal(fs.readFileSync(result, 'utf8'), 'existing bytes');
  assert.equal(f.calls().length, 1);
});

test('standard CLI resume reuses one submitted task', t => {
  const f = fixture(t, [{}, { exit: 28 }, { body: { result: { text: 'resumed' } } }]);
  assert.notEqual(f.run('v3-standard').status, 0);
  assert.notEqual(f.run('v3-standard').status, 0);
  const recovered = f.run('v3-standard', ['--resume']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(f.calls().filter(call => call.args.some(arg => arg.endsWith('/submit'))).length, 1);
  assert.equal(f.calls().length, 3);
});

test('resume rejects changed input bytes or engine before network', t => {
  const f = fixture(t, [{ body: { result: { text: 'saved' } } }]);
  assert.equal(f.run().status, 0);
  assert.notEqual(f.run('v3-standard', ['--resume']).status, 0);
  fs.writeFileSync(f.input, 'changed audio');
  assert.notEqual(f.run('flash', ['--resume']).status, 0);
  assert.equal(f.calls().length, 1);
});

test('managed BASE rejects provider CLI and directs the user to the formal resume entry', t => {
  const f = fixture(t, []);
  fs.mkdirSync(f.out);
  fs.writeFileSync(path.join(f.out, 'invocation.json'), JSON.stringify({ invocationId: 'managed', state: 'complete', owner: { pid: process.pid, token: 'owner' }, transcribeDir: path.join(f.out, '1_转录') }));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run_transcribe\.sh --resume/);
  assert.deepEqual(fs.readdirSync(f.out), ['invocation.json']);
  assert.equal(f.calls().length, 0);
});

test('URL input retains exact URL identity and request body', t => {
  const f = fixture(t, [{ body: { result: { text: 'remote' } } }]);
  const url = 'https://example.invalid/audio.wav?signature=fake';
  const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/volcengine_flash_transcribe.sh'), url, f.out], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls()[0].body.audio, { url, format: 'wav' });
  const task = JSON.parse(fs.readFileSync(path.join(f.out, '.asr', 'task.json')));
  assert.equal(task.audioPath, url);
});

test('standalone lock rejects a second owner and cancellation waits for curl cleanup', async t => {
  const f = fixture(t, [{ block: true }]);
  const child = spawn('bash', [path.resolve(__dirname, '../scripts/volcengine_flash_transcribe.sh'), f.input, f.out], { env: f.env, stdio: 'ignore' });
  const completed = new Promise(resolve => child.on('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  for (let n = 0; n < 200 && !fs.existsSync(path.join(f.root, 'started')); n++) await new Promise(resolve => setTimeout(resolve, 10));
  const curlPid = Number(fs.readFileSync(path.join(f.root, 'started')));
  const concurrent = f.run('flash', ['--resume']);
  assert.notEqual(concurrent.status, 0);
  assert.match(concurrent.stderr, /活动写入所有者/);
  assert.equal(f.calls().length, 1);
  child.kill('SIGTERM');
  assert.notEqual(await completed, 0);
  assert.throws(() => process.kill(curlPid, 0), /ESRCH/);
  assert.deepEqual(fs.readdirSync(path.join(f.out, '.asr')).sort(), ['standalone.json', 'task.json']);
  const resumed = f.run('flash', ['--resume']);
  assert.match(resumed.stderr, /new invocation/);
  assert.equal(f.calls().length, 1);
});
