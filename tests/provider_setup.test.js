'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// All credentials, setup markers, commands and network responses are isolated.
// Only the HTTPS transport is replaced; doctor and the shell loader run unchanged.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roughcut-provider-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, 'skill');
  fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(skillDir, 'scripts'), { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['ffmpeg', 'ffprobe', 'python3', 'curl']) {
    fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const capture = path.join(root, 'requests.jsonl');
  const preload = path.join(root, 'fake_https.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
require('node:https').request = (options, callback) => {
  const req = new EventEmitter();
  let body = '';
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.write = value => { body += value; };
  req.end = () => {
    fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ options, body }) + '\\n');
    process.nextTick(() => {
      const all = JSON.parse(process.env.FAKE_RESPONSES);
      const reply = all[options.headers['X-Api-Resource-Id']];
      if (!reply) throw new Error('Unexpected resource');
      if (reply.netErr) { req.emit('error', new Error(reply.netErr)); return; }
      const res = new EventEmitter();
      res.statusCode = reply.http;
      res.headers = reply.status ? { 'x-api-status-code': reply.status } : {};
      callback(res);
      res.emit('data', '{}');
      res.emit('end');
    });
  };
  return req;
};
`);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    VOLCENGINE_API_KEY: '',
    VOLCENGINE_ENV_FILE: '',
    NODE_OPTIONS: '',
    FAKE_CAPTURE: capture,
  };
  function doctor(replies = {}, args = ['--force', '--json']) {
    const success = { http: 200, status: '20000000' };
    const result = spawnSync(process.execPath, ['--require', preload, path.join(skillDir, 'scripts/doctor.js'), ...args], {
      env: {
        ...env,
        FAKE_RESPONSES: JSON.stringify({
          'volc.bigasr.auc_turbo': replies.flash || success,
          'volc.bigasr.auc': replies.std || success,
        }),
      }, encoding: 'utf8', timeout: 5000,
    });
    const line = result.stdout.split('\n').find(value => value.startsWith('__DOCTOR_JSON__ '));
    return { ...result, report: line ? JSON.parse(line.slice('__DOCTOR_JSON__ '.length)) : null };
  }
  function shellKey() {
    return spawnSync('bash', ['-c', 'SCRIPT_DIR="$1"; . "$SCRIPT_DIR/lib/load_api_key.sh"; printf "%s" "$API_KEY"', 'loader', path.join(skillDir, 'scripts')], {
      env, encoding: 'utf8', timeout: 5000,
    });
  }
  function select(requested, last = '', extra = []) {
    return spawnSync(process.execPath, [path.join(skillDir, 'scripts/select_transcribe_engine.js'), '--configured', requested, last, skillDir, ...extra], {
      env, encoding: 'utf8', timeout: 5000,
    });
  }
  function requests() {
    if (!fs.existsSync(capture)) return [];
    return fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  }
  function setup(availableEngines) {
    fs.writeFileSync(path.join(skillDir, '.setup_done'), JSON.stringify({ version: 1, availableEngines }));
  }
  return { root, skillDir, bin, env, doctor, shellKey, select, requests, setup };
}

for (const [name, line, expected] of [
  ['plain', 'VOLCENGINE_API_KEY=synthetic=key\n', 'synthetic=key'],
  ['quoted whitespace', '  VOLCENGINE_API_KEY = "  synthetic key  "  \r\n', '  synthetic key  '],
  ['single quotes', "VOLCENGINE_API_KEY='synthetic $key #literal'\n", 'synthetic $key #literal'],
  ['unquoted inner spaces', 'VOLCENGINE_API_KEY=  synthetic key  \n', 'synthetic key'],
]) {
  test(`doctor and shell use identical ${name} credential bytes`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.skillDir, '.env'), line);
    const shell = f.shellKey();
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout, expected);
    assert.equal(f.doctor().status, 0);
    assert.deepEqual(f.requests().map(request => request.options.headers['X-Api-Key']), [expected, expected]);
  });
}

test('environment key has byte-preserving priority over all dotenv files', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = '  synthetic-env  ';
  fs.writeFileSync(path.join(f.skillDir, '.env'), 'VOLCENGINE_API_KEY=first\nVOLCENGINE_API_KEY=second\n');
  assert.equal(f.shellKey().stdout, '  synthetic-env  ');
  assert.equal(f.doctor().status, 0);
  assert.deepEqual(f.requests().map(request => request.options.headers['X-Api-Key']), ['  synthetic-env  ', '  synthetic-env  ']);
});

test('both consumers reject duplicate keys without probing or exposing either value', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.skillDir, '.env'), 'VOLCENGINE_API_KEY=synthetic-first\n VOLCENGINE_API_KEY = synthetic-last\n');
  const shell = f.shellKey();
  const doctor = f.doctor();
  assert.notEqual(shell.status, 0);
  assert.notEqual(doctor.status, 0);
  assert.equal(doctor.report.envState, 'duplicate_key');
  assert.equal(f.requests().length, 0);
  assert.doesNotMatch(shell.stdout + shell.stderr + doctor.stdout + doctor.stderr, /synthetic-first|synthetic-last/);
});

for (const invalid of ['duplicate', 'invalid']) {
  test(`an existing setup marker cannot hide current ${invalid} credentials`, t => {
    const f = fixture(t);
    f.setup(['flash', 'v3-standard']);
    if (invalid === 'duplicate') {
      fs.writeFileSync(path.join(f.skillDir, '.env'), 'VOLCENGINE_API_KEY=synthetic-one\nVOLCENGINE_API_KEY=synthetic-two\n');
    } else {
      f.env.VOLCENGINE_API_KEY = 'synthetic-key\n';
    }
    const result = f.doctor({}, ['--json']);
    assert.equal(f.shellKey().status, 1);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.ready, false);
    assert.equal(result.report.envState, invalid === 'duplicate' ? 'duplicate_key' : 'invalid_key');
    assert.equal(f.requests().length, 0);
  });
}

for (const marker of ['legacy', 'capabilities']) {
  test(`${marker} setup does not replace a current resource probe`, t => {
    const f = fixture(t);
    f.env.VOLCENGINE_API_KEY = 'synthetic-key';
    if (marker === 'legacy') fs.writeFileSync(path.join(f.skillDir, '.setup_done'), '2026-01-01T00:00:00Z\n');
    else f.setup(['flash', 'v3-standard']);
    const result = f.doctor({ flash: { http: 503 }, std: { http: 503 } }, ['--json']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.ready, false);
    assert.deepEqual(result.report.availableEngines, []);
    assert.equal(f.requests().length, 2);
  });
}

for (const command of ['ffmpeg', 'ffprobe', 'node', 'python3', 'curl']) {
  test(`a failing ${command} command prevents setup readiness`, t => {
    const f = fixture(t);
    f.env.VOLCENGINE_API_KEY = 'synthetic-key';
    fs.writeFileSync(path.join(f.bin, command), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    const result = f.doctor();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.ready, false);
    assert.equal(result.report.depsOk, false);
    assert.deepEqual(result.report.missingDeps, [command]);
  });
}

test('python alone cannot satisfy the pipeline requirement for python3', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = 'synthetic-key';
  f.env.PATH = f.bin;
  fs.unlinkSync(path.join(f.bin, 'python3'));
  for (const command of ['python', 'node']) {
    fs.writeFileSync(path.join(f.bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const result = f.doctor();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.report.ready, false);
  assert.deepEqual(result.report.missingDeps, ['python3']);
});

for (const [name, key, line] of [
  ['placeholder', 'your_api_key_here', null],
  ['newline in environment', 'synthetic-key\n', null],
  ['unclosed quote', '', 'VOLCENGINE_API_KEY="synthetic-key\n'],
]) {
  test(`both consumers reject ${name} before any network request`, t => {
    const f = fixture(t);
    f.env.VOLCENGINE_API_KEY = key;
    if (line) fs.writeFileSync(path.join(f.skillDir, '.env'), line);
    const shell = f.shellKey();
    const doctor = f.doctor();
    assert.equal(shell.status, 1);
    assert.equal(doctor.status, 1);
    assert.equal(f.requests().length, 0);
  });
}

test('explicit dotenv file takes priority, then skill and legacy parent files', t => {
  const f = fixture(t);
  const explicit = path.join(f.root, 'explicit.env');
  f.env.VOLCENGINE_ENV_FILE = explicit;
  fs.writeFileSync(explicit, 'VOLCENGINE_API_KEY=synthetic-explicit\n');
  fs.writeFileSync(path.join(f.skillDir, '.env'), 'VOLCENGINE_API_KEY=synthetic-skill\n');
  fs.writeFileSync(path.join(f.root, '.env'), 'VOLCENGINE_API_KEY=synthetic-parent\n');
  for (const [expected, remove] of [
    ['synthetic-explicit', explicit],
    ['synthetic-skill', path.join(f.skillDir, '.env')],
    ['synthetic-parent', null],
  ]) {
    assert.equal(f.shellKey().stdout, expected);
    assert.equal(f.doctor().status, 0);
    assert.equal(f.requests().at(-1).options.headers['X-Api-Key'], expected);
    if (remove) fs.unlinkSync(remove);
  }
});

for (const [name, reply] of [
  ['HTTP 503 without business status', { http: 503 }],
  ['HTTP 503 with a contradictory success status', { http: 503, status: '20000000' }],
  ['HTTP 503 with a contradictory silence status', { http: 503, status: '20000003' }],
  ['HTTP 200 without business status', { http: 200 }],
  ['a pending business status', { http: 200, status: '20000001' }],
  ['a queued business status', { http: 200, status: '20000002' }],
  ['an unknown business error', { http: 200, status: '55000031' }],
  ['an invalid-audio response', { http: 200, status: '45000003' }],
  ['a network failure', { netErr: 'synthetic offline' }],
]) {
  test(`${name} never makes setup ready`, t => {
    const f = fixture(t);
    f.env.VOLCENGINE_API_KEY = 'synthetic-key';
    const result = f.doctor({ flash: reply, std: reply });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.allGreen, false);
    assert.equal(result.report.ready, false);
    assert.equal(fs.existsSync(path.join(f.skillDir, '.setup_done')), false);
  });
}

test('flash-only setup accepts its documented completed silence probe', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = 'synthetic-key';
  const result = f.doctor({
    flash: { http: 200, status: '20000003' },
    std: { http: 200, status: '45000151' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.ready, true);
  assert.deepEqual(result.report.availableEngines, ['flash']);
  assert.equal(result.report.recommendedFlag, '--flash');
  assert.match(result.stdout, /静音探测.*完成/);
  const request = f.requests().find(value => value.options.headers['X-Api-Resource-Id'] === 'volc.bigasr.auc_turbo');
  const audio = Buffer.from(JSON.parse(request.body).audio.data, 'base64');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  assert.ok(audio.length > 44);
  assert.ok(audio.subarray(44).every(value => value === 0), 'silence status is accepted only for the known silent probe');
});

test('standard submit does not treat an unexpected silence status as accepted', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = 'synthetic-key';
  const result = f.doctor({
    flash: { http: 200, status: '45000151' },
    std: { http: 200, status: '20000003' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.report.ready, false);
  assert.deepEqual(result.report.availableEngines, []);
});

test('documented audio format errors are not diagnosed as missing authorization', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = 'synthetic-key';
  const result = f.doctor({
    flash: { http: 200, status: '45000151' },
    std: { http: 200, status: '45000151' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /音频格式/);
  assert.doesNotMatch(result.stdout, /资源未开通/);
});

for (const [available, replies, flag] of [
  [['flash'], { std: { http: 200, status: '45000151' } }, '--flash'],
  [['v3-standard'], { flash: { http: 200, status: '45000151' } }, '--v3-standard'],
  [['flash', 'v3-standard'], {}, '--auto'],
]) {
  test(`${available.join('+')} completes setup and exposes its executable choice`, t => {
    const f = fixture(t);
    f.env.VOLCENGINE_API_KEY = 'synthetic-key';
    const result = f.doctor(replies);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.report.ready, true);
    assert.deepEqual(result.report.availableEngines, available);
    assert.equal(result.report.recommendedFlag, flag);
    const setup = JSON.parse(fs.readFileSync(path.join(f.skillDir, '.setup_done'), 'utf8'));
    assert.deepEqual(setup.availableEngines, available);
    const rechecked = f.doctor(replies, ['--json']);
    assert.equal(rechecked.status, 0);
    assert.deepEqual(rechecked.report.availableEngines, available);
    assert.equal(f.requests().length, 4, 'an explicit doctor invocation must check current resources');
  });
}

test('doctor sends a valid small WAV instead of invalid ping bytes', t => {
  const f = fixture(t);
  f.env.VOLCENGINE_API_KEY = 'synthetic-key';
  assert.equal(f.doctor().status, 0);
  for (const request of f.requests()) {
    const body = JSON.parse(request.body);
    const audio = Buffer.from(body.audio.data, 'base64');
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
    assert.equal(audio.readUInt32LE(4), audio.length - 8);
    assert.equal(audio.readUInt32LE(40), audio.length - 44);
    assert.ok(audio.length > 44 && audio.length <= 32044);
  }
});

test('auto uses the one configured resource regardless of previous engine', t => {
  const f = fixture(t);
  for (const available of ['flash', 'v3-standard']) {
    f.setup([available]);
    for (const last of ['', 'flash', 'v3-standard']) {
      const result = f.select('auto', last);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${available}\n`);
    }
  }
});

test('dual-resource and legacy setup retain alternating auto behavior', t => {
  const f = fixture(t);
  for (const marker of [null, '2026-01-01T00:00:00Z\n', JSON.stringify({ version: 1, availableEngines: ['flash', 'v3-standard'] })]) {
    if (marker !== null) fs.writeFileSync(path.join(f.skillDir, '.setup_done'), marker);
    for (const [last, expected] of [['', 'flash'], ['flash', 'v3-standard'], ['v3-standard', 'flash']]) {
      const result = f.select('auto', last);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${expected}\n`);
    }
  }
});

test('explicit unavailable resources fail with the available flag', t => {
  const f = fixture(t);
  f.setup(['flash']);
  const result = f.select('v3-standard');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--flash/);
  assert.equal(result.stdout, '');
});

test('oversized auto review only falls back when standard is available or capability is unknown', t => {
  const f = fixture(t);
  const { fileFingerprint } = require('../scripts/lib/media_manifest');
  const audioPath = path.join(f.root, 'review_audio.mp3');
  fs.writeFileSync(audioPath, 'synthetic-media');
  const fingerprint = fileFingerprint(audioPath);
  const count = 2 * 60 * 60 * 48000 + 1;
  const contextPath = path.join(f.root, 'media_context.json');
  fs.writeFileSync(contextPath, JSON.stringify({
    sourcePath: audioPath, reviewAudioPath: audioPath, playbackPath: audioPath, exportPath: audioPath,
    sourceFingerprint: fingerprint, reviewFingerprint: fingerprint,
    mediaType: 'audio', source: { rate: 1, presentationStart: 0, sampleRate: 48000, channels: 1 },
    timebase: { kind: 'audio-samples', ticksPerSecond: 48000 },
    review: { extension: 'mp3', sizeBytes: 1024, sampleRate: 48000, channels: 1, decodedSampleCount: count, duration: count / 48000 },
    offsets: {
      playerPresentationOffset: { status: 'verified', seconds: 0 },
      sourceMediaOffset: { status: 'verified', seconds: 0 },
      asrPresentationOffset: { status: 'pending_user_validation' },
    },
  }));
  function choose() {
    return spawnSync(process.execPath, [path.join(f.skillDir, 'scripts/select_transcribe_engine.js'), 'auto', 'flash', contextPath, f.skillDir], {
      env: f.env, encoding: 'utf8', timeout: 5000,
    });
  }
  assert.equal(choose().stdout, 'v3-standard\n');
  f.setup(['flash', 'v3-standard']);
  assert.equal(choose().stdout, 'v3-standard\n');
  f.setup(['flash']);
  const result = choose();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /超出.*极速版.*标准版/);
  assert.match(result.stderr, /--v3-standard/);
});
