'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {claimInvocation,finishInvocation,verifyTranscript}=require('../scripts/lib/invocation');
const {publishTranscript}=require('../scripts/lib/transcript_publication');
const {loadAndVerifyMediaContext}=require('../scripts/lib/media_manifest');
const {makeAudio}=require('./helpers/media_fixtures');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'roughcut-reuse-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=makeAudio(root,'wav'),base=path.join(root,'original'),claim=claimInvocation(base,source),dir=claim.record.transcribeDir;
  const credentials={SPEECH_ROUGHCUT_INVOCATION:claim.record.invocationId,SPEECH_ROUGHCUT_OWNER:claim.record.owner.token};
  execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/prepare_media.js'),source,dir],{env:{...process.env,...credentials}});
  const context=JSON.parse(fs.readFileSync(path.join(dir,'media_context.json')));
  const rawPath=path.join(root,'raw.json');fs.writeFileSync(rawPath,'{"localFixture":true}');
  const transcript={version:1,words:[{id:'same-word-id',text:'原文',startSample:4800,endSample:14400}],asrBreaks:[]};
  publishTranscript({dir,context,transcript,rawPath,credentials});finishInvocation(claim,'complete');
  fs.mkdirSync(path.join(base,'2_分析'));fs.writeFileSync(path.join(base,'2_分析/manual.json'),'人工状态');
  const guard=path.join(root,'deny-network.cjs');
  fs.writeFileSync(guard,`const Module=require('node:module'),load=Module._load;
    Module._load=function(id,...args){if(/provider|volcengine|doctor/.test(id))throw Error('provider 调用禁止');return load.call(this,id,...args)};
    for(const name of ['node:http','node:https','node:net','node:tls']){const m=require(name);for(const k of ['request','get','connect','createConnection'])if(m[k])m[k]=()=>{throw Error('网络禁止')}};
    global.fetch=()=>{throw Error('网络禁止')};`);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('VOLCENGINE')&&!key.startsWith('SPEECH_ROUGHCUT')&&!key.endsWith('API_KEY')));
  env.NODE_OPTIONS=`--require=${guard}`;
  const run=target=>spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/reuse_transcript.js'),base,target],{encoding:'utf8',env});
  return {root,base,source,dir,context,transcript,run};
}
test('无凭证、网络及 provider 禁止时，复用保留原资产／clock／word ID且不继承人工状态',t=>{
  const f=fixture(t),target=path.join(f.root,'new'),before=fs.readFileSync(path.join(f.dir,'review_audio.mp3'));
  const result=f.run(target);assert.equal(result.status,0,result.stderr);
  const dir=path.join(target,'1_转录'),contextFile=path.join(dir,'media_context.json'),context=loadAndVerifyMediaContext(contextFile);
  verifyTranscript(contextFile,context,path.join(dir,'subtitles_words.json'),path.join(dir,'asr_breaks.json'));
  assert.notEqual(context.invocationId,f.context.invocationId);assert.equal(context.sourcePath,f.context.sourcePath);
  assert.deepEqual(context.offsets,f.context.offsets);assert.deepEqual(context.timebase,f.context.timebase);assert.deepEqual(context.review,f.context.review);
  assert.deepEqual(fs.readFileSync(path.join(dir,'review_audio.mp3')),before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'transcript.json'))),f.transcript);
  assert.equal(fs.existsSync(path.join(target,'2_分析')),false);
  assert.equal(fs.existsSync(path.join(dir,'.asr')),false);
  const again=f.run(target);assert.notEqual(again.status,0);assert.match(again.stderr,/占用|产物/);
  const invocationFile=path.join(target,'invocation.json'),invocation=JSON.parse(fs.readFileSync(invocationFile));
  invocation.state='failed';invocation.owner.pid=999999;fs.writeFileSync(invocationFile,JSON.stringify(invocation));
  const frozen=fs.readFileSync(invocationFile);
  const resumed=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/run_transcribe.js'),'--resume',target],{encoding:'utf8',
    env:{PATH:process.env.PATH}});
  assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/离线复用失败不能恢复为 ASR/);
  assert.deepEqual(fs.readFileSync(invocationFile),frozen);
});
test('来源内容身份异常先拒绝，不创建新 invocation 或回退识别',t=>{
  const f=fixture(t),target=path.join(f.root,'bad');
  fs.appendFileSync(path.join(f.dir,'subtitles_words.json'),' ');
  const result=f.run(target);assert.notEqual(result.status,0);assert.match(result.stderr,/归属|变化/);
  assert.equal(fs.existsSync(path.join(target,'invocation.json')),false);
});
