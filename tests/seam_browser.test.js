'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const {makeMarkerWav}=require('./helpers/media_fixtures');
const {openChrome,stopChild,delay,freePort,waitUntilReady}=require('./helpers/review_browser');
const {audioSuggestionInputHash,seamInputHash}=require('../scripts/lib/audio_suggestion_input');
const {replayEditSnapshot}=require('../scripts/lib/edit_snapshot');
test('接缝复核随恢复、开关、边界、重叠手工与 undo/redo 更新；浏览器及冻结导出计划相同',{timeout:60000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roughcut-seam-browser-'));let server,chrome;
  t.after(async()=>{if(chrome)await chrome.close();await stopChild(server);fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
  const repo=path.resolve(__dirname,'..'),dir=path.join(root,'1_转录'),review=path.join(root,'3_审核');
  const source=makeMarkerWav(root,{duration:8});
  execFileSync(process.execPath,[path.join(repo,'scripts/prepare_media.js'),source,dir]);
  const contextFile=path.join(dir,'media_context.json'),mediaContext=JSON.parse(fs.readFileSync(contextFile));
  const words=[{id:'a',text:'保留',startSample:4800,endSample:48000},{id:'b',text:'弃用',startSample:144000,endSample:192000},
    {id:'c',text:'重录',startSample:240000,endSample:288000}];
  const seamPreparation={version:1,initialDeletedWordIds:['b'],decisions:[{id:'retake',deletedWordIds:['b'],leftWordId:'a',rightWordId:'c',
    keepLeftSamples:4800,keepRightSamples:4800,retainedSounds:[],status:'resolved',hearingStatus:'pending',reason:'弃用重说',basis:'转写上下文，声音待听审'}]};
  seamPreparation.inputHash=seamInputHash({words,mediaContext,initialSuggestedWordDeletes:['b']});
  for(const [name,value]of[['words',words],['breaks',[]],['selected',{wordIds:['b']}],['suggestions',{
    inputHash:audioSuggestionInputHash({words,mediaContext}),suggestions:[],seamPreparation}]])fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value));
  execFileSync(process.execPath,[path.join(repo,'scripts/generate_review.js'),...['words','breaks','selected'].map(n=>path.join(root,n+'.json')),contextFile,review,path.join(root,'suggestions.json')]);
  server=spawn(process.execPath,[path.join(repo,'scripts/review_server.js'),String(await freePort()),contextFile],{cwd:review,stdio:['ignore','pipe','pipe']});
  await waitUntilReady(server);chrome=await openChrome(fs.readFileSync(path.join(review,'server_url.txt'),'utf8').trim(),path.join(root,'chrome'));
  for(let n=0;n<500;n++){const r=await chrome.evaluate('({ready:window.__reviewTest?.ready,error:window.__reviewTest?.error})');if(r.error)assert.fail(r.error);if(r.ready)break;if(n===499)assert.fail('接缝工作台初始化超时');await delay(20);}
  const initial=await chrome.evaluate('({plan:__reviewTest.getPlan(),audit:__reviewTest.getSeamAudit()})');
  assert.equal(initial.plan.cuts.length,1);assert.deepEqual(initial.audit.fragments,[]);
  const edits=await chrome.evaluate(`(() => {
    const initial=JSON.stringify(__reviewTest.getPlan());
    __reviewTest.dispatch({type:'RESTORE_WORD',wordId:'b'});
    const restored=__reviewTest.getPlan().retainedWordIds.includes('b'),independent=__reviewTest.getPlan().cuts.length===2;
    const stale=__reviewTest.getSeamAudit().seamReviews[0].status;
    __reviewTest.undo();const undo=JSON.stringify(__reviewTest.getPlan())===initial;
    __reviewTest.redo();const redo=__reviewTest.getPlan().retainedWordIds.includes('b');__reviewTest.undo();
    __reviewTest.dispatch({type:'SET_AUDIO_SUGGESTION_ENABLED',id:'seam-retake-left-0',enabled:false});
    const toggle=__reviewTest.getSeamAudit().seamReviews[0].status;__reviewTest.undo();
    __reviewTest.dispatch({type:'SET_AUDIO_SUGGESTION_RANGE',range:{id:'seam-retake-right-0',startSample:204480,endSample:235200}});
    __reviewTest.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{id:'overlap',startSample:187200,endSample:196800}});
    const audit=__reviewTest.getSeamAudit(),same=__reviewTest.getConsumerConsistency().sameObject;
    const before=JSON.stringify(__reviewTest.getPlan());document.querySelector('#seamAudit button').click();
    return {restored,independent,stale,undo,redo,toggle,audit,same,readonly:before===JSON.stringify(__reviewTest.getPlan())};
  })()`);
  for(const key of ['restored','independent','undo','redo','same','readonly'])assert.equal(edits[key],true,key);
  assert.equal(edits.stale,'user-edited');assert.equal(edits.toggle,'user-edited');assert.equal(edits.audit.fragments[0].status,'user-edited');
  const exported=await chrome.evaluate(`(async()=>{const plan=__reviewTest.getPlan(),editState=__reviewTest.getEditState();
    const r=await fetch('/api/fcpxml',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({compiledCutPlan:plan,editState})});return {status:r.status,body:await r.json(),plan};})()`);
  assert.equal(exported.status,200,JSON.stringify(exported.body));
  const snapshot=JSON.parse(fs.readFileSync(path.join(review,'exports',exported.body.revision,'edit_snapshot.json')));
  assert.deepEqual(snapshot.inputs.seamPreparation,seamPreparation);assert.deepEqual(replayEditSnapshot(snapshot),exported.plan);
});
