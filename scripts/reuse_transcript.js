#!/usr/bin/env node
'use strict';
// This entry point never imports an ASR adapter, credentials, or setup/doctor.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {canonical,claimInvocation,finishInvocation,verifyTranscript} = require('./lib/invocation');
const {loadAndVerifyMediaContext,fileFingerprint} = require('./lib/media_manifest');
const {publishTranscript} = require('./lib/transcript_publication');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
function reuseTranscript(sourceBaseArg, targetBaseArg) {
  const sourceBase = canonical(sourceBaseArg), targetBase = canonical(targetBaseArg);
  const dir = path.join(sourceBase,'1_转录'), contextFile = path.join(dir,'media_context.json');
  const context = loadAndVerifyMediaContext(contextFile);
  const identity = verifyTranscript(contextFile,context,path.join(dir,'subtitles_words.json'),path.join(dir,'asr_breaks.json'));
  if (!identity?.canonical) throw new Error('离线复用需要已有成功、完整绑定的 canonical transcript');
  const transcriptBytes = fs.readFileSync(path.join(dir,'transcript.json'));
  if (hash(transcriptBytes) !== identity.canonical.sha256) throw new Error('复用 canonical 内容已变化');
  const audio = fs.readFileSync(context.reviewAudioPath);
  const raw = fs.readFileSync(path.join(dir,'volcengine_v3_result.json'));
  if (hash(raw) !== identity.result.sha256) throw new Error('复用 raw 内容已变化');
  JSON.parse(raw.toString('utf8'));
  const provenance = {mode:'offline-transcript-reuse',sourceBase,sourceInvocationId:context.invocationId,
    sourceContextHash:hash(fs.readFileSync(contextFile)),sourceTranscriptIdentity:identity,
    reviewAudioSha256:hash(audio),canonicalSha256:hash(transcriptBytes)};
  // Recheck the frozen parent before claiming any new identity.
  loadAndVerifyMediaContext(contextFile);
  verifyTranscript(contextFile,context,path.join(dir,'subtitles_words.json'),path.join(dir,'asr_breaks.json'));
  if (sourceBase === targetBase || fs.existsSync(targetBase) && fs.readdirSync(targetBase).some(name=>name!=='.run.lock')) {
    throw new Error('复用目标已占用或包含产物；必须使用新的 BASE');
  }
  const claim = claimInvocation(targetBase,context.sourcePath);
  try {
    claim.record.mode = 'offline-transcript-reuse';
    fs.writeFileSync(claim.file,`${JSON.stringify(claim.record,null,2)}\n`);
    const newDir = claim.record.transcribeDir, reviewAudioPath = path.join(newDir,'review_audio.mp3');
    fs.mkdirSync(newDir,{recursive:true});
    fs.writeFileSync(reviewAudioPath,audio,{flag:'wx'});
    const nextContext = {...context,invocationId:claim.record.invocationId,reviewAudioPath,
      playbackPath:context.mediaType==='audio'?reviewAudioPath:context.playbackPath,reviewFingerprint:fileFingerprint(reviewAudioPath)};
    fs.writeFileSync(path.join(newDir,'media_context.json'),`${JSON.stringify(nextContext,null,2)}\n`,{flag:'wx'});
    const rawPath = path.join(newDir,'.reuse_raw.json');
    fs.writeFileSync(rawPath,raw,{flag:'wx'});
    try {
      publishTranscript({dir:newDir,context:nextContext,transcript:JSON.parse(transcriptBytes),rawPath,
        credentials:{SPEECH_ROUGHCUT_INVOCATION:claim.record.invocationId,SPEECH_ROUGHCUT_OWNER:claim.record.owner.token}});
    } finally { fs.rmSync(rawPath,{force:true}); }
    fs.writeFileSync(path.join(newDir,'reuse_identity.json'),`${JSON.stringify(provenance,null,2)}\n`,{flag:'wx'});
    finishInvocation(claim,'complete');
    verifyTranscript(path.join(newDir,'media_context.json'),loadAndVerifyMediaContext(path.join(newDir,'media_context.json')),
      path.join(newDir,'subtitles_words.json'),path.join(newDir,'asr_breaks.json'));
    return {base:targetBase,invocationId:claim.record.invocationId,provenance};
  } catch (error) { finishInvocation(claim,'failed'); throw error; }
}
if (require.main === module) {
  const [sourceArg,targetArg,...extra] = process.argv.slice(2);
  if (!sourceArg || !targetArg || extra.length) { console.error('用法: node reuse_transcript.js <成功 BASE> <新 BASE>'); process.exitCode=1; }
  else {
    const source=path.resolve(sourceArg), target=path.resolve(targetArg);
    if (process.env.SPEECH_ROUGHCUT_LOCKED_BASE !== target) {
      const child=spawn('python3',[path.join(__dirname,'lib/run_locked.py'),target,process.execPath,__filename,source,target],{stdio:'inherit'});
      for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
      child.once('error',error=>{console.error(error.message);process.exitCode=1;});
      child.once('exit',code=>{process.exitCode=code||0;});
    } else { try { console.log(JSON.stringify(reuseTranscript(source,target))); } catch(error) { console.error(error.message);process.exitCode=1; } }
  }
}
module.exports = { reuseTranscript };
