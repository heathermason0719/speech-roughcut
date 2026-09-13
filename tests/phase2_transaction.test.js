'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeAudio } = require('./helpers/media_fixtures');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase2-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skill');
  fs.mkdirSync(skill);
  fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(skill, 'scripts'), { recursive: true });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(root, 'calls.jsonl');
  const control = path.join(root, 'control.json');
  fs.writeFileSync(control, '{}');
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}\n
const fs=require('node:fs');
const args=process.argv.slice(2); const kind=args.some(x=>x.endsWith('/submit'))?'submit':args.some(x=>x.endsWith('/query'))?'query':'flash';
const header=name=>args.find(x=>x.toLowerCase().startsWith(name.toLowerCase()+': '));
fs.appendFileSync(process.env.P2_CALLS,JSON.stringify({kind,id:header('X-Api-Request-Id')})+'\\n');
const c=JSON.parse(fs.readFileSync(process.env.P2_CONTROL));
const output=args[args.indexOf('-o')+1], hdr=args[args.indexOf('-D')+1];
const raw={result:{text:'甲乙',utterances:[{text:'甲乙',words:[{text:'甲',start_time:100,end_time:300},{text:'乙',start_time:700,end_time:900}]}]}};
if(kind==='query'&&c.queryNetworkFailure){process.exit(7);}
if(kind==='flash'&&c.blockLocal){fs.mkdirSync(process.env.P2_BASE+'/1_转录/transcript.json');}
fs.writeFileSync(hdr,'HTTP/1.1 200 OK\\r\\nX-Api-Status-Code: 20000000\\r\\nX-Tt-Logid: fake-log\\r\\n');
fs.writeFileSync(output,JSON.stringify(kind==='submit'?{}:raw));
process.stdout.write('200');
`, { mode: 0o755 });
  const source = makeAudio(root, 'wav');
  const base = path.join(root, 'run');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VOLCENGINE_API_KEY: 'phase2-fake-key', P2_CALLS: calls, P2_CONTROL: control, P2_BASE: base };
  const run = (args, overrides={}) => spawnSync('bash', [path.join(skill, 'scripts/run_transcribe.sh'), ...args], { cwd: root, env:{...env,...overrides},encoding:'utf8',timeout:30000 });
  const history = () => fs.existsSync(calls) ? fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, skill, base, source, env, run, history, control };
}

test('accepted async task survives a failed query; explicit resume never submits again', t => {
  const f=setup(t);
  fs.writeFileSync(f.control,JSON.stringify({queryNetworkFailure:true}));
  const first=f.run([f.source,f.base,'--v3-standard']);
  assert.notEqual(first.status,0,first.stdout+first.stderr);
  assert.equal(f.history().filter(x=>x.kind==='submit').length,1);
  assert.equal(fs.existsSync(path.join(f.base,'1_转录/volcengine_v3_result.json')),false);
  fs.writeFileSync(f.control,'{}');
  const resumed=f.run(['--resume',f.base]);
  assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
  const calls=f.history();
  assert.equal(calls.filter(x=>x.kind==='submit').length,1);
  assert.equal(new Set(calls.map(x=>x.id)).size,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.base,'invocation.json'))).state,'complete');
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.base,'1_转录/transcript.json'))).words.length);
  const ordinary=f.run([f.source,f.base,'--v3-standard']);
  assert.notEqual(ordinary.status,0);
  assert.equal(f.history().length,calls.length);
});

test('valid raw survives local publish failure and resumes locally without credentials or provider calls', t => {
  const f=setup(t);
  fs.writeFileSync(f.control,JSON.stringify({blockLocal:true}));
  const first=f.run([f.source,f.base,'--flash']);
  assert.notEqual(first.status,0,first.stdout+first.stderr);
  assert.equal(f.history().length,1);
  const dir=path.join(f.base,'1_转录');
  assert.equal(fs.existsSync(path.join(dir,'volcengine_v3_result.json')),false);
  assert.equal(fs.existsSync(path.join(dir,'.asr/raw_result.json')),true);
  fs.rmdirSync(path.join(dir,'transcript.json'));
  fs.writeFileSync(f.control,'{}');
  const resumed=f.run(['--resume',f.base],{VOLCENGINE_API_KEY:'xxx'});
  assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
  assert.equal(f.history().length,1);
  const before=fs.readFileSync(path.join(dir,'volcengine_v3_result.json'));
  const again=f.run(['--resume',f.base],{VOLCENGINE_API_KEY:'xxx'});
  assert.equal(again.status,0,again.stdout+again.stderr);
  assert.equal(f.history().length,1);
  assert.deepEqual(fs.readFileSync(path.join(dir,'volcengine_v3_result.json')),before);
});

test('resume forbids extra media/engine arguments before changing an invocation', t => {
  const f=setup(t);
  for(const args of [['--resume',f.base,f.source],['--resume',f.base,'--flash'],['--resume']]) {
    const result=f.run(args);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/参数|用法|resume/);
  }
  assert.equal(fs.existsSync(f.base),false);
  assert.equal(f.history().length,0);
  const { parseArgs } = require('../scripts/run_transcribe');
  assert.equal(parseArgs(['--', '--resume']).source, path.resolve('--resume'));
});

test('local normalization failure replays the same valid raw after repairing local processing', t => {
  const f = setup(t);
  const adapter = path.join(f.skill, 'scripts/lib/volc_normalize.js');
  const original = fs.readFileSync(adapter);
  fs.writeFileSync(adapter, "exports.normalizeVolcResult = () => { throw new Error('local normalizer unavailable'); };\n");
  const first = f.run([f.source, f.base, '--flash']);
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /local normalizer unavailable/);
  const dir = path.join(f.base, '1_转录');
  assert.equal(fs.existsSync(path.join(dir, 'subtitles_words.json')), false);
  const raw = fs.readFileSync(path.join(dir, '.asr/raw_result.json'));
  fs.writeFileSync(adapter, original);
  const resumed = f.run(['--resume', f.base], { VOLCENGINE_API_KEY: 'xxx' });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(f.history().length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'volcengine_v3_result.json')), raw);
});

test('killed invocation resumes an accepted task; concurrent resume is rejected by the owner lock', async t => {
  const f = setup(t);
  const child = spawn('bash', [path.join(f.skill, 'scripts/run_transcribe.sh'), f.source, f.base, '--v3-standard'], {
    cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', bytes => { log += bytes; });
  child.stderr.on('data', bytes => { log += bytes; });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(() => child.kill('SIGTERM'));
  const taskFile = path.join(f.base, '1_转录/.asr/task.json');
  const deadline = Date.now() + 15000;
  let task;
  while (Date.now() < deadline && child.exitCode === null) {
    if (fs.existsSync(taskFile)) task = JSON.parse(fs.readFileSync(taskFile));
    if (task?.status === 'accepted') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(task?.status, 'accepted', log);
  const concurrent = f.run(['--resume', f.base]);
  assert.notEqual(concurrent.status, 0);
  assert.match(concurrent.stderr, /所有者|并发/);
  const record = JSON.parse(fs.readFileSync(path.join(f.base, 'invocation.json')));
  process.kill(record.owner.pid, 'SIGKILL');
  assert.notEqual(await exited, 0);
  const resumed = f.run(['--resume', f.base]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(f.history().filter(call => call.kind === 'submit').length, 1);
  assert.equal(new Set(f.history().map(call => call.id)).size, 1);
});

test('resume rejects changed media before querying; publication survives interruption before completion receipt', t => {
  const f = setup(t);
  fs.writeFileSync(f.control, JSON.stringify({queryNetworkFailure: true}));
  assert.notEqual(f.run([f.source, f.base, '--v3-standard']).status, 0);
  const original = fs.readFileSync(f.source);
  fs.appendFileSync(f.source, 'changed');
  const calls = f.history().length;
  const mismatch = f.run(['--resume', f.base]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /指纹|变化/);
  assert.equal(f.history().length, calls);
  fs.writeFileSync(f.source, original);
  fs.writeFileSync(f.control, '{}');
  // A fresh independent success models the small crash window after pointer publication.
  const other = path.join(f.root, 'published');
  assert.equal(f.run([f.source, other, '--flash']).status, 0);
  const recordFile = path.join(other, 'invocation.json');
  const record = JSON.parse(fs.readFileSync(recordFile));
  record.state = 'running';
  fs.writeFileSync(recordFile, JSON.stringify(record));
  const before = f.history().length;
  const recovered = f.run(['--resume', other], { VOLCENGINE_API_KEY: 'xxx' });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(f.history().length, before);
  assert.equal(JSON.parse(fs.readFileSync(recordFile)).state, 'complete');
});
