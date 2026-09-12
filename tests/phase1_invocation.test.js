'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { makeAudio, makeVfrVideo } = require('./helpers/media_fixtures');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');

const project = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase1-invocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skill');
  fs.mkdirSync(skill);
  fs.cpSync(path.join(project, 'scripts'), path.join(skill, 'scripts'), { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Only curl is replaced. Media prep, provider request building, parsing and downstream are real.
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, 'called\\n');
if (process.env.FAKE_STARTED) fs.writeFileSync(process.env.FAKE_STARTED, 'started');
async function main() {
  while (process.env.FAKE_RELEASE && !fs.existsSync(process.env.FAKE_RELEASE)) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  fs.writeFileSync(args[args.indexOf('-D') + 1], 'HTTP/1.1 200 OK\\r\\nX-Api-Status-Code: 20000000\\r\\n');
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({result:{utterances:[{words:[
    {text:process.env.FAKE_WORD || '甲',start_time:100,end_time:300},
    {text:'乙',start_time:700,end_time:900}
  ]}]}}));
  if (args.includes('-w')) process.stdout.write('200');
}
main();
`, { mode: 0o755 });
  const source = makeAudio(root, 'wav', { duration: 1.5 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VOLCENGINE_API_KEY: 'phase1-fake-key', FAKE_CALLS: path.join(root, 'calls') };
  const run = args => spawnSync('bash', [path.join(skill, 'scripts/run_transcribe.sh'), ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, skill, source, env, run };
}

test('CLI flags at either side preserve source/output identity and implicit invocations are unique', (t) => {
  const { root, source, run } = fixture(t);
  const before = hash(source);
  for (const args of [
    [source, '--flash'], ['--flash', source], [source, '--flash', 'explicit one'],
    ['--flash', source, 'explicit two'], [source, 'explicit three', '--flash'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(fs.existsSync(path.join(root, '--flash')), false);
  const bases = fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'invocation.json')));
  assert.equal(bases.length, 5);
  const records = bases.map(name => JSON.parse(fs.readFileSync(path.join(root, name, 'invocation.json'))));
  assert.equal(new Set(records.map(record => record.invocationId)).size, 5);
  assert.ok(records.every(record => record.state === 'complete'));
  assert.equal(hash(source), before);
});

test('standalone preparation refuses to replace the original when it is also the review output', (t) => {
  const { root } = fixture(t);
  const original = makeAudio(root, 'mp3');
  const source = path.join(root, 'review_audio.mp3');
  fs.renameSync(original, source);
  const before = hash(source);
  const result = spawnSync(process.execPath, [path.join(project, 'scripts/prepare_media.js'), source, root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /原始|覆盖/);
  assert.equal(hash(source), before);
});

test('ambiguous CLI fails before creating any formal output or calling provider', (t) => {
  const { root, source, run, env } = fixture(t);
  const before = fs.readdirSync(root).sort();
  for (const args of [[source, '--wat'], [source, '--flash', '--auto'], [source, 'one', 'two'], ['--flash'], []]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stdout + result.stderr, /用法|参数|引擎/);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(fs.existsSync(env.FAKE_CALLS), false);
});

test('same BASE refuses concurrent and subsequent writers; bound transcripts reject mixed media', async (t) => {
  const { root, skill, source, env, run } = fixture(t);
  const base = path.join(root, 'shared');
  const started = path.join(root, 'started');
  const release = path.join(root, 'release');
  t.after(() => { if (fs.existsSync(root)) fs.writeFileSync(release, 'cleanup'); });
  const child = spawn('bash', [path.join(skill, 'scripts/run_transcribe.sh'), source, base, '--flash'], {
    cwd: root, env: { ...env, FAKE_STARTED: started, FAKE_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(started) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(started), log);
  const otherDir = path.join(root, 'other');
  fs.mkdirSync(otherDir);
  const other = makeAudio(otherDir, 'wav', { duration: 1.8 });
  const rejected = run([other, base, '--flash']);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /invocation|占用|所有者/);
  fs.writeFileSync(release, 'go');
  assert.equal(await exited, 0, log);
  assert.equal(fs.readFileSync(env.FAKE_CALLS, 'utf8').trim().split('\n').length, 1);
  assert.notEqual(run([other, base, '--flash']).status, 0);
  const transcribe = path.join(base, '1_转录');
  const context = JSON.parse(fs.readFileSync(path.join(transcribe, 'media_context.json')));
  const identity = JSON.parse(fs.readFileSync(path.join(transcribe, 'transcript_identity.json')));
  assert.equal(context.sourcePath, fs.realpathSync(source));
  assert.equal(context.invocationId, identity.invocationId);
  // A direct helper must also refuse to overwrite a managed invocation.
  const overwritten = spawnSync(process.execPath, [path.join(skill, 'scripts/prepare_media.js'), other, transcribe], { encoding: 'utf8' });
  assert.notEqual(overwritten.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(transcribe, 'media_context.json'))).sourcePath, context.sourcePath);

  const baseB = path.join(root, 'second');
  assert.equal(run([other, baseB, '--flash']).status, 0);
  const selected = path.join(root, 'selected.json');
  fs.writeFileSync(selected, '{"wordIds":[]}');
  const words = path.join(transcribe, 'subtitles_words.json');
  const breaks = path.join(transcribe, 'asr_breaks.json');
  const generate = (contextFile, outDir) => spawnSync(process.execPath, [path.join(skill, 'scripts/generate_review.js'), words, breaks, selected, contextFile, outDir], { encoding: 'utf8' });
  const valid = generate(path.join(transcribe, 'media_context.json'), path.join(base, '3_审核'));
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const mixed = generate(path.join(baseB, '1_转录/media_context.json'), path.join(root, 'mixed'));
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /invocation|身份|归属/);
  assert.equal(fs.existsSync(path.join(root, 'mixed/data.json')), false);
  // Even copied-in foreign content cannot inherit identity merely by using the expected name.
  fs.writeFileSync(words, '[{"id":"word-000000","text":"foreign","startSample":4800,"endSample":14400}]');
  const changed = generate(path.join(transcribe, 'media_context.json'), path.join(root, 'changed'));
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /invocation|身份|变化/);
});

test('VFR fails before fake ASR and source remains unchanged', (t) => {
  const { root, run, env } = fixture(t);
  const source = makeVfrVideo(root);
  const before = hash(source);
  const result = run([source, path.join(root, 'vfr-run'), '--flash']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /仅支持 CFR/);
  assert.equal(fs.existsSync(env.FAKE_CALLS), false);
  assert.equal(hash(source), before);
});

test('relative review paths survive launcher cd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase1-relative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'review'));
  fs.writeFileSync(path.join(root, 'context.json'), '{}');
  fs.writeFileSync(path.join(root, 'server.js'), "require('node:fs').writeFileSync('received.json', JSON.stringify(process.argv.slice(2)));\n");
  execFileSync('bash', [path.join(project, 'scripts/serve_review.sh'), 'review', 'context.json', 'server.js', '8899'], {
    cwd: root, env: { ...process.env, SERVE_REVIEW_NO_SPAWN: '1' },
  });
  const name = process.platform === 'darwin' ? '启动审核服务.command' : '启动审核服务.sh';
  const result = spawnSync('bash', [path.join(root, 'review', name)], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(fs.readFileSync(path.join(root, 'review/received.json')));
  assert.equal(received[0], '8899');
  assert.equal(fs.realpathSync(received[1]), fs.realpathSync(path.join(root, 'context.json')));
});

test('formal fake-ASR invocation closes through analysis, review, compiled plan, FCPXML and learning diff', async (t) => {
  const { root, source, skill, run } = fixture(t);
  const base = path.join(root, 'complete-flow');
  const result = run([source, base, '--flash']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dir = path.join(base, '1_转录');
  const wordsFile = path.join(dir, 'subtitles_words.json');
  const breaksFile = path.join(dir, 'asr_breaks.json');
  const contextFile = path.join(dir, 'media_context.json');
  const analysisDir = path.join(base, '2_分析');
  const reviewDir = path.join(base, '3_审核');
  execFileSync(process.execPath, [path.join(skill, 'scripts/gen_analysis.js'), wordsFile, breaksFile, analysisDir]);
  execFileSync(process.execPath, [path.join(skill, 'scripts/generate_review.js'), wordsFile, breaksFile,
    path.join(analysisDir, 'auto_selected.json'), contextFile, reviewDir]);
  const data = JSON.parse(fs.readFileSync(path.join(reviewDir, 'data.json')));
  const editState = createEditState({ initialSuggestedWordDeletes: data.initialSuggestedWordDeletes,
    manualDeleteRanges: [{ startSample: 16000, endSample: 24000 }], policy: { autoSilenceEnabled: false } });
  const compiledCutPlan = compileEdit({ words: data.words, asrBreaks: data.asrBreaks,
    detectedSilence: [], editState, mediaContext: data.mediaContext });
  const port = await new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.on('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const available = reservation.address().port;
      reservation.close(error => error ? reject(error) : resolve(available));
    });
  });
  const server = spawn(process.execPath, [path.join(skill, 'scripts/review_server.js'), String(port), contextFile], {
    cwd: reviewDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => server.once('exit', resolve));
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  try {
    const deadline = Date.now() + 5000;
    while (!log.includes('READY_PORT=') && server.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(log, /READY_PORT=/);
    const media = await fetch(`http://127.0.0.1:${port}/video`);
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), fs.readFileSync(data.mediaContext.reviewAudioPath));
    const exported = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiledCutPlan, includeTitles: true }),
    });
    const payload = await exported.json();
    assert.equal(exported.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);
    assert.match(fs.readFileSync(payload.output, 'utf8'), /asset-clip/);
    assert.ok(JSON.parse(fs.readFileSync(payload.learningDiff)).mediaName);
    // A running server rechecks the binding instead of trusting its startup snapshot.
    fs.writeFileSync(wordsFile, '[]');
    const changed = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiledCutPlan, includeTitles: true }),
    });
    assert.notEqual(changed.status, 200);
    assert.match((await changed.json()).error, /invocation|变化/);
  } finally {
    server.kill('SIGTERM');
    await exited;
  }
});
