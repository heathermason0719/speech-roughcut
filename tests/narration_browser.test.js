'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const {makeMarkerWav}=require('./helpers/media_fixtures');
const {openChrome,stopChild,delay,freePort,waitUntilReady}=require('./helpers/review_browser');
const {audioSuggestionInputHash}=require('../scripts/lib/audio_suggestion_input');
const {replayEditSnapshot}=require('../scripts/lib/edit_snapshot');

test('自动粗剪工作台：单条／分组恢复、边界修改、撤销及正式导出', {timeout:60000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roughcut-narration-'));let chrome,server;
  t.after(async()=>{if(chrome)await chrome.close();await stopChild(server);fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
  const repo=path.resolve(__dirname,'..'), transcribe=path.join(root,'1_转录'), review=path.join(root,'3_审核');
  const source=makeMarkerWav(root,{duration:8});
  execFileSync(process.execPath,[path.join(repo,'scripts/prepare_media.js'),source,transcribe]);
  const contextFile=path.join(transcribe,'media_context.json'), mediaContext=JSON.parse(fs.readFileSync(contextFile));
  const words=[{id:'a',text:'自然',startSample:4800,endSample:48000},
    {id:'b',text:'句子',startSample:144000,endSample:192000},{id:'c',text:'继续',startSample:240000,endSample:288000}];
  const suggestions=[['p1','long',55200,136800],['p2','short',201600,230400],['p3','long',297600,374400]]
    .map(([id,groupId,startSample,endSample])=>({id,groupId,groupLabel:groupId==='long'?'长停顿':'短停顿',startSample,endSample,reason:'本段上下文停顿偏长',basis:'波形与转写'}));
  for(const [name,data] of [['words',words],['breaks',[]],['selected',{wordIds:['a']}],['suggestions',{
    inputHash:audioSuggestionInputHash({words,mediaContext}),suggestions}]])fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(data));
  execFileSync(process.execPath,[path.join(repo,'scripts/generate_review.js'),...['words','breaks','selected'].map(n=>path.join(root,n+'.json')),contextFile,review,path.join(root,'suggestions.json')]);
  server=spawn(process.execPath,[path.join(repo,'scripts/review_server.js'),String(await freePort()),contextFile],{cwd:review,stdio:['ignore','pipe','pipe']});
  await waitUntilReady(server);
  const url=fs.readFileSync(path.join(review,'server_url.txt'),'utf8').trim();
  chrome=await openChrome(url,path.join(root,'chrome'));
  for(let n=0;n<500;n++) {const r=await chrome.evaluate('({ready:window.__reviewTest?.ready,error:window.__reviewTest?.error})');
    if(r.error)assert.fail(r.error);if(r.ready)break;if(n===499)assert.fail('初始化超时');await delay(20);}

  await t.test('有冻结建议的新页面默认应用并显示入口，没有正文数字胶囊',async()=>{
    const r=await chrome.evaluate(`({state:__reviewTest.getEditState(),cuts:__reviewTest.getPlan().cuts.length,
      visible:!!document.getElementById('audioSuggestionEditor').getClientRects().length,
      markers:document.querySelectorAll('.audio-suggestion-marker').length,
      chips:document.querySelectorAll('.paragraph-body .gap').length})`);
    assert.equal(r.state.policy.version,'narration-v1');assert.equal(r.cuts,4);assert.equal(r.visible,true);assert.equal(r.markers,3);assert.equal(r.chips,0);
  });
  await t.test('恢复一类及全部不撤销独立手工删除；单条恢复参与 undo/redo',async()=>{
    const r=await chrome.evaluate(`(() => {
      __reviewTest.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{id:'independent',startSample:65000,endSample:70000}});
      const decisions=JSON.stringify(__reviewTest.getPlan().wordDecisions);
      document.querySelector('[data-audio-group="long"]').click();
      const groupCuts=__reviewTest.getPlan().cuts.length;
      document.getElementById('enableAudioSuggestions').click();const allCuts=__reviewTest.getPlan().cuts.length;
      document.getElementById('enableAudioSuggestions').click();
      document.querySelector('[data-audio-group="long"]').click();
      document.getElementById('suggestionEnabled').click();const after=__reviewTest.getPlan();
      __reviewTest.undo();const undone=__reviewTest.getEditState().disabledAudioSuggestionIds.length===0;
      __reviewTest.redo();return {groupCuts,allCuts,undone,same:JSON.stringify(after)===JSON.stringify(__reviewTest.getPlan()),
        learning:decisions===JSON.stringify(__reviewTest.getPlan().wordDecisions),manual:__reviewTest.getEditState().manualDeleteRanges.length};
    })()`);
    assert.deepEqual(r,{groupCuts:3,allCuts:2,undone:true,same:true,learning:true,manual:1});
  });
  await t.test('自动范围以原 ID 调整，草稿不改变计划；失效边界拒绝提交',async()=>{
    const r=await chrome.evaluate(`(() => {
      document.getElementById('suggestionEnabled').click();
      document.querySelector('[data-suggestion-id="p1"]').click();
      document.getElementById('adjustSuggestion').click();
      const before=JSON.stringify(__reviewTest.getPlan());
      const set=value=>{const n=document.getElementById('rangeStart');n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));};
      set('1.5');const draftOnly=before===JSON.stringify(__reviewTest.getPlan());document.getElementById('deleteRange').click();
      const adjusted=__reviewTest.getEditState().audioSuggestionRanges;
      document.getElementById('adjustSuggestion').click();set('7');
      document.getElementById('deleteRange').click();
      return {draftOnly,adjusted,unchanged:JSON.stringify(adjusted)===JSON.stringify(__reviewTest.getEditState().audioSuggestionRanges),
        manual:__reviewTest.getEditState().manualDeleteRanges.length,consistent:__reviewTest.getConsumerConsistency().sameObject};
    })()`);
    assert.equal(r.draftOnly,true);assert.equal(r.unchanged,true);assert.equal(r.manual,1);assert.equal(r.consistent,true);
    assert.deepEqual(r.adjusted,[{id:'p1',startSample:72000,endSample:136800}]);
  });
  await t.test('正式导出重放冻结建议和用户覆盖，旧 plan-only 页面仍兼容',async()=>{
    const r=await chrome.evaluate(`(async()=>{
      const payload={compiledCutPlan:__reviewTest.getPlan(),editState:__reviewTest.getEditState(),includeTitles:true};
      const response=await fetch('/api/fcpxml',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      return {status:response.status,body:await response.json(),plan:payload.compiledCutPlan};
    })()`);
    assert.equal(r.status,200,JSON.stringify(r.body));
    const revisions=fs.readdirSync(path.join(review,'exports'));
    assert.equal(revisions.length,1);
    const snapshot=JSON.parse(fs.readFileSync(path.join(review,'exports',revisions[0],'edit_snapshot.json')));
    assert.deepEqual(snapshot.inputs.audioSuggestions,suggestions);
    assert.deepEqual(replayEditSnapshot(snapshot),r.plan);
    const old=await chrome.evaluate(`(async()=>{const r=await fetch('/api/fcpxml',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({compiledCutPlan:__reviewTest.getPlan(),includeTitles:true})});return r.status;})()`);
    assert.equal(old,200);
  });
  await t.test('清除全部包含自动音频决定，并可一次撤销回完整原状态',async()=>{
    const result=await chrome.evaluate(`(() => {const before=JSON.stringify(__reviewTest.getEditState());
      clearAll();const cuts=__reviewTest.getPlan().cuts.length;__reviewTest.undo();
      return {cuts,restored:before===JSON.stringify(__reviewTest.getEditState())};})()`);
    assert.deepEqual(result,{cuts:0,restored:true});
  });
  await t.test('从显式编辑起点重开：恢复词、原范围 ID、建议边界与正式导出完全保持',async()=>{
    const saved=await chrome.evaluate(`(() => {
      __reviewTest.dispatch({type:'RESTORE_WORD',wordId:'a'});
      return {state:__reviewTest.getEditState(),plan:__reviewTest.getPlan()};
    })()`);
    await stopChild(server);
    const file=path.join(review,'data.json'),data=JSON.parse(fs.readFileSync(file));
    data.restoredEditState=saved.state;fs.writeFileSync(file,JSON.stringify(data));
    server=spawn(process.execPath,[path.join(repo,'scripts/review_server.js'),String(await freePort()),contextFile],{cwd:review,stdio:['ignore','pipe','pipe']});
    await waitUntilReady(server);
    await chrome.send('Page.navigate',{url:fs.readFileSync(path.join(review,'server_url.txt'),'utf8').trim()});
    for(let n=0;n<800;n++){const status=await chrome.evaluate('({ready:window.__reviewTest?.ready,error:window.__reviewTest?.error})');
      if(status.error)assert.fail(status.error);if(status.ready)break;if(n===799)assert.fail('恢复初始化超时');await delay(20);}
    const loaded=await chrome.evaluate('({state:__reviewTest.getEditState(),plan:__reviewTest.getPlan()})');
    assert.deepEqual(loaded,saved);
    const r=await chrome.evaluate(`(async()=>{
      document.querySelector('[data-range-id="independent"] [data-action="remove"]').click();
      const removed=__reviewTest.getEditState().manualDeleteRanges.length===0;__reviewTest.undo();
      const state=__reviewTest.getEditState(),plan=__reviewTest.getPlan();
      const r=await fetch('/api/fcpxml',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({compiledCutPlan:plan,editState:state,includeTitles:true})});
      return {removed,state,plan,status:r.status,body:await r.json()};
    })()`);
    assert.equal(r.removed,true);assert.deepEqual(r.state,saved.state);assert.deepEqual(r.plan,saved.plan);
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.deepEqual(replayEditSnapshot(JSON.parse(fs.readFileSync(path.join(review,'exports',r.body.revision,'edit_snapshot.json')))),saved.plan);
  });
});

test('听审反馈：0.7 秒候选与波形／正文联动不改变声音', {timeout:60000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roughcut-follow-'));let chrome,server;
  t.after(async()=>{if(chrome)await chrome.close();await stopChild(server);fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
  const repo=path.resolve(__dirname,'..'), transcribe=path.join(root,'1_转录'), review=path.join(root,'3_审核');
  const source=makeMarkerWav(root,{duration:6});
  execFileSync(process.execPath,[path.join(repo,'scripts/prepare_media.js'),source,transcribe]);
  const contextFile=path.join(transcribe,'media_context.json');
  const words=[{id:'a',text:'开头',startSample:4800,endSample:24000},
    {id:'b',text:'不到零点七秒',startSample:57599,endSample:72000},
    {id:'c',text:'正好零点七秒',startSample:105600,endSample:120000},
    {id:'d',text:'短停连',startSample:139200,endSample:158400},
    {id:'e',text:'最后一句',startSample:196800,endSample:264000}];
  const breaks=words.slice(0,-1).map((word,i)=>({id:`gap-${i}`,previousWordId:word.id,
    nextWordId:words[i+1].id,startSample:word.endSample,endSample:words[i+1].startSample}));
  for(const [name,data] of [['words',words],['breaks',breaks],['selected',{wordIds:[]}]])
    fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(data));
  execFileSync(process.execPath,[path.join(repo,'scripts/generate_review.js'),...['words','breaks','selected'].map(n=>path.join(root,n+'.json')),contextFile,review]);
  fs.writeFileSync(path.join(review,'detected_silence.json'),'[]');
  server=spawn(process.execPath,[path.join(repo,'scripts/review_server.js'),String(await freePort()),contextFile],{cwd:review,stdio:['ignore','pipe','pipe']});
  await waitUntilReady(server);
  chrome=await openChrome(fs.readFileSync(path.join(review,'server_url.txt'),'utf8').trim(),path.join(root,'chrome'));
  for(let n=0;n<500;n++) {const r=await chrome.evaluate('({ready:window.__reviewTest?.ready,error:window.__reviewTest?.error})');
    if(r.error)assert.fail(r.error);if(r.ready)break;if(n===499)assert.fail('初始化超时');await delay(20);}

  await t.test('0.7 秒含边界，一个 sample 以下隐藏，短候选展开与显示均不删音',async()=>{
    const r=await chrome.evaluate(`(() => {
      const before=JSON.stringify(__reviewTest.getPlan());
      const hidden=()=>[...document.querySelectorAll('.pause-marker')].map(n=>n.hidden);
      const initial=hidden();document.getElementById('showShortPauses').click();const expanded=hidden();
      document.getElementById('showShortPauses').click();
      const same=before===JSON.stringify(__reviewTest.getPlan());
      __reviewTest.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{id:'short-edit',startSample:30000,endSample:40000}});
      const edited=hidden();__reviewTest.undo();
      return {initial,expanded,edited,same,restored:before===JSON.stringify(__reviewTest.getPlan())};
    })()`);
    assert.deepEqual(r,{initial:[true,false,true,false],expanded:[false,false,false,false],
      edited:[false,false,true,false],same:true,restored:true});
  });

  // A narrow viewport represents an actual long transcript without a long media fixture.
  await chrome.evaluate(`(() => {
    const s=document.querySelector('.transcript-scroll');s.style.flex='none';s.style.height='120px';s.style.padding='0';
    document.querySelectorAll('.paragraph').forEach(n=>n.style.minHeight='180px');
    window.followProbe=()=>{const s=document.querySelector('.transcript-scroll'),r=s.getBoundingClientRect();
      const visible=id=>{const n=document.querySelector('[data-word-id="'+id+'"]'),b=n.getBoundingClientRect();
        return b.top>=r.top && b.bottom<=r.bottom;};
      const p=document.getElementById('player');return {visible:visible(window.followTarget),
        current:document.querySelector('.word.current')?.dataset.wordId||null,
        time:p.currentTime,paused:p.paused,pageScroll:window.scrollY,targetSample:window.lastWaveTargetSample,
        plan:JSON.stringify(__reviewTest.getPlan())};};
    window.waveSeek=seconds=>{waveZoomFit();const c=document.getElementById('waveCanvas'),r=c.getBoundingClientRect();
      const event=new MouseEvent('click',{bubbles:true,clientX:r.left+r.width*seconds/6,clientY:r.top+5});
      // DOM mouse coordinates use whole CSS pixels; assert the sample at that actual pixel.
      window.lastWaveTargetSample=Math.max(0,Math.min(288000,Math.round((event.clientX-r.left)/r.width*288000)));
      c.dispatchEvent(event);};
  })()`);
  const initialPlan=await chrome.evaluate('JSON.stringify(__reviewTest.getPlan())');

  await t.test('波形定位让对应文字可见，同一词再次定位也有效，暂停与计划不变',async()=>{
    for(let attempt=0;attempt<2;attempt++) {
      const r=await chrome.evaluate(`(() => {document.querySelector('.transcript-scroll').scrollTop=0;
        window.followTarget='e';waveSeek(4.5);return followProbe();})()`);
      assert.equal(r.visible,true);assert.equal(r.current,'e');assert.equal(r.paused,true);
      assert.ok(Math.abs(r.time-4.5)<=1/48000);assert.equal(r.plan,initialPlan);assert.equal(r.pageScroll,0);
    }
  });

  await t.test('无 word 空档定位最近上下文但不伪造当前词或改变播放时间',async()=>{
    for(const [seconds,id] of [[3.9,'e'],[0.8,'a'],[0,'a'],[5.9,'e']]) {
      const r=await chrome.evaluate(`(() => {window.followTarget=${JSON.stringify(id)};waveSeek(${seconds});return followProbe();})()`);
      assert.equal(r.visible,true,`${seconds}s`);assert.equal(r.current,null);
      assert.ok(Math.abs(r.time*48000-r.targetSample)<=1,JSON.stringify(r));
      assert.equal(r.paused,true);assert.equal(r.plan,initialPlan);
    }
  });

  await t.test('连续播放跨段会跟随文字，仅滚正文，不抢焦点或重排波形时间',async()=>{
    const r=await chrome.evaluate(`(async()=>{window.followTarget='d';waveSeek(2.3);
      const button=document.getElementById('playBtn');button.focus();button.click();
      const p=document.getElementById('player');
      for(let n=0;n<200 && p.currentTime<3.02;n++)await new Promise(r=>setTimeout(r,20));
      const playing=!p.paused;p.pause();
      return {...followProbe(),playing,focused:document.activeElement===button};})()`);
    assert.equal(r.visible,true);assert.equal(r.current,'d');assert.equal(r.playing,true);assert.equal(r.focused,true);
    assert.ok(r.time>=3.02 && r.time<3.3);assert.equal(r.pageScroll,0);assert.equal(r.plan,initialPlan);
  });
});
