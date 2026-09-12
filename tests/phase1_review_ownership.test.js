'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { bindResult, claimInvocation, finishInvocation } = require('../scripts/lib/invocation');
const { makeAudio } = require('./helpers/media_fixtures');

const scripts = path.resolve(__dirname, '../scripts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase1-review-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = path.join(root, 'selected.json');
  fs.writeFileSync(selected, '{"wordIds":[]}');
  function invocation(name) {
    const sourceDir = path.join(root, `source-${name}`);
    fs.mkdirSync(sourceDir);
    const source = makeAudio(sourceDir, 'wav');
    const claim = claimInvocation(path.join(root, name), source);
    const env = {
      ...process.env,
      SPEECH_ROUGHCUT_INVOCATION: claim.record.invocationId,
      SPEECH_ROUGHCUT_OWNER: claim.record.owner.token,
    };
    const dir = claim.record.transcribeDir;
    execFileSync(process.execPath, [path.join(scripts, 'prepare_media.js'), claim.record.sourcePath, dir], {
      env, stdio: 'pipe',
    });
    const result = path.join(dir, 'volcengine_v3_result.json');
    fs.writeFileSync(result, JSON.stringify({ result: { utterances: [{ words: [
      { text: name, start_time: 100, end_time: 300 },
    ] }] } }));
    bindResult(dir, env);
    const context = path.join(dir, 'media_context.json');
    execFileSync(process.execPath, [path.join(scripts, 'generate_subtitles.js'), result, context, dir], {
      env, stdio: 'pipe',
    });
    finishInvocation(claim, 'complete');
    const review = path.join(path.dirname(dir), '3_审核');
    const args = outDir => [
      path.join(scripts, 'generate_review.js'), path.join(dir, 'subtitles_words.json'),
      path.join(dir, 'asr_breaks.json'), selected, context, outDir,
    ];
    return { context, review, args, claim, env, dir };
  }
  return { root, invocation };
}

function generate(run, outDir = run.review, options = {}) {
  return spawnSync(process.execPath, run.args(outDir), { encoding: 'utf8', ...options });
}

test('正式审核输入不能覆盖另一 BASE 的审核文件', t => {
  const { invocation } = fixture(t);
  const a = invocation('a');
  const b = invocation('b');
  const initial = generate(a);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  const dataFile = path.join(a.review, 'data.json');
  const before = fs.readFileSync(dataFile);
  const mixed = generate(b, a.review);
  assert.equal(mixed.status, 1, mixed.stdout + mixed.stderr);
  assert.match(mixed.stderr, /invocation|BASE|身份|归属|输出目录/);
  assert.deepEqual(fs.readFileSync(dataFile), before, '拒绝混用必须发生在任何审核产物覆盖之前');
});

test('同一 invocation 的审核生成互斥，首个 writer 完成后可正常重建', async t => {
  const { root, invocation } = fixture(t);
  const run = invocation('shared');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const started = path.join(root, 'analysis-started');
  const release = path.join(root, 'analysis-release');
  const ffmpeg = execFileSync('bash', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
  // Hold the first real PCM analysis after it owns the output directory. This
  // avoids relying on process-start timing to overlap two writers.
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${process.execPath}\n
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
(async () => {
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
  const child = spawn(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code == null ? 1 : code));
})();
`, { mode: 0o755 });
  const first = spawn(process.execPath, run.args(run.review), {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  first.stdout.on('data', chunk => { output += chunk; });
  first.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    first.on('exit', resolve);
    first.on('error', reject);
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(started) && first.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(started), output || '首个 writer 未进入 PCM 分析');
    const second = generate(run);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stderr, /writer|写入|占用|所有者|生成/);
  } finally {
    fs.writeFileSync(release, 'release');
    assert.equal(await exited, 0, output);
  }
  const rebuilt = generate(run);
  assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
});

test('服务启动不能在另一 BASE 中加载复制的合法审核数据', t => {
  const { invocation } = fixture(t);
  const a = invocation('a');
  const b = invocation('b');
  const initial = generate(a);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  fs.mkdirSync(b.review, { recursive: true });
  fs.copyFileSync(path.join(a.review, 'data.json'), path.join(b.review, 'data.json'));
  const server = spawnSync(process.execPath, [path.join(scripts, 'review_server.js'), '0', a.context], {
    cwd: b.review, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(server.status, 1, server.stdout + server.stderr);
  assert.match(server.stderr, /invocation|BASE|身份|归属|输出目录/);
  assert.doesNotMatch(server.stdout, /READY_PORT=/, '错误 BASE 必须在监听端口前拒绝');
});

test('持有写入凭据也不能用独立 context 为正式 invocation 重新绑定外来 words', t => {
  const { root, invocation } = fixture(t);
  const run = invocation('owned');
  const foreignContext = path.join(root, 'foreign-context.json');
  const context = JSON.parse(fs.readFileSync(run.context));
  delete context.invocationId;
  fs.writeFileSync(foreignContext, JSON.stringify(context));
  const foreignResult = path.join(root, 'foreign-result.json');
  fs.writeFileSync(foreignResult, JSON.stringify({ result: { utterances: [{ words: [
    { text: '外来', start_time: 100, end_time: 300 },
  ] }] } }));
  // Hold an active formal owner while attempting to feed unbound inputs.
  finishInvocation(run.claim, 'running');
  const wordsFile = path.join(run.dir, 'subtitles_words.json');
  const before = fs.readFileSync(wordsFile);
  const result = spawnSync(process.execPath, [path.join(scripts, 'generate_subtitles.js'),
    foreignResult, foreignContext, run.dir], { env: run.env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /invocation|身份|归属/);
  assert.deepEqual(fs.readFileSync(wordsFile), before);
});
