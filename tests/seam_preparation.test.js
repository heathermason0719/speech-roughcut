'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readAudioSuggestionInput, audioSuggestionInputHash, seamInputHash } = require('../scripts/lib/audio_suggestion_input');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { transitionEditState } = require('../scripts/lib/edit_state');
const { prepareSeams, auditSeams } = require('../scripts/lib/seam_preparation');
const { buildEditSnapshot, replayEditSnapshot } = require('../scripts/lib/edit_snapshot');
const rate = 48000;
const word = (id, start, end) => ({id, text:id, startSample:Math.round(start*rate), endSample:Math.round(end*rate)});
const words = [word('a',503,504.03), word('d1',507,513.81), word('d2',513.81,515.21), word('b',515.97,516.2),
  word('c',545.88,546.12), word('d3',546.7,546.9), word('d4',546.9,547.06), word('e',547.66,548)];
const mediaContext = {sourceFingerprint:{test:'recording'},review:{sampleRate:rate,decodedSampleCount:rate*550},
  timebase:{kind:'audio-samples',ticksPerSecond:rate},offsets:{sourceMediaOffset:{seconds:0,status:'verified'}}};
const selected = ['d1','d2','d3','d4'];
const state = createEditState({initialSuggestedWordDeletes:selected,currentDeletedWordIds:selected,policy:{version:'narration-v1'}});
const suggestion = (id,start,end) => ({id,groupId:'pause',groupLabel:'停顿',startSample:Math.round(start*rate),
  endSample:Math.round(end*rate),reason:'旧局部范围',basis:'旧流程边界'});
const old = [suggestion('p1',515.495,515.685),suggestion('p2',546.16,546.66),suggestion('p3',547.32,547.6)];
const compile = suggestions => compileEdit({words,mediaContext,audioSuggestions:suggestions,editState:state});
const islands = plan => plan.keeps.filter(k=>k.reviewStartSample>0&&k.reviewEndSample<rate*550
  && !plan.retainedWordIds.some(id=>{const w=words.find(w=>w.id===id);return w.startSample<k.reviewEndSample&&w.endSample>k.reviewStartSample;}));
const decision = (id,deletedWordIds,leftWordId,rightWordId,keepLeftSamples,keepRightSamples,retainedSounds=[]) => ({
  id,deletedWordIds,leftWordId,rightWordId,keepLeftSamples,keepRightSamples,retainedSounds,
  status:'resolved',hearingStatus:'pending',reason:'弃用重录与两侧语流统一衔接',basis:'转写上下文；未完成真人听审'});
const preparation = {version:1,initialDeletedWordIds:selected,decisions:[
  decision('first',['d1','d2'],'a','b',4800,13680),
  decision('second',['d3','d4'],'c','e',1920,2880)]};
preparation.inputHash=seamInputHash({words,mediaContext,initialSuggestedWordDeletes:selected});
const envelope = prep => ({inputHash:audioSuggestionInputHash({words,mediaContext}),suggestions:[],seamPreparation:prep});

test('旧局部范围留下 285/40/260ms；整段接缝的补删与删词精确相接',()=>{
  // Existing outward source-grid rounding adds at most two source samples.
  assert.deepEqual(islands(compile(old)).map(k=>k.reviewEndSample-k.reviewStartSample),[13680,1921,12482]);
  const suggestions=readAudioSuggestionInput(envelope(preparation),{words,mediaContext,initialSuggestedWordDeletes:selected});
  const plan=compile(suggestions);
  assert.deepEqual(islands(plan),[]);
  assert.equal(suggestions.find(s=>s.id==='seam-first-right-0').endSample,24752880);
  assert.deepEqual(plan.cuts.map(c=>[c.reviewStartSample,c.reviewEndSample]),[[24198240,24752879],[26215680,26284800]]);
});

test('明确短声音和待听声音保留且可审计；审计不按长度或 PCM 补删',()=>{
  const prep=structuredClone(preparation);
  prep.decisions[0].retainedSounds=[{startSample:24730080,endSample:24743760,status:'intentional',reason:'独立短声音需要保留'}];
  prep.decisions[1].retainedSounds=[{startSample:26258880,endSample:26271360,status:'pending',reason:'这段声音无法判断，保留待听'}];
  const suggestions=readAudioSuggestionInput(envelope(prep),{words,mediaContext,initialSuggestedWordDeletes:selected}),plan=compile(suggestions);
  const before=JSON.stringify(plan),audit=auditSeams({plan,words,editState:state,preparation:prep,audioSuggestions:suggestions});
  assert.deepEqual(audit.fragments.map(f=>f.status),['intentional','pending']);assert.deepEqual(audit.preparationFailures,[]);
  assert.equal(JSON.stringify(plan),before);
  const naturalWords=[word('short',546.66,546.7),word('speech',548,549)];
  const naturalPlan=compileEdit({words:naturalWords,mediaContext,audioSuggestions:old.slice(1),
    detectedSilence:[{startSample:26239680,endSample:26258880,thresholdDb:-35,energy:{maxDb:-90}}],
    editState:createEditState({policy:{version:'narration-v1',minimumKeepSamples:999999}})});
  assert.ok(naturalPlan.retainedWordIds.includes('short'));
  assert.ok(naturalPlan.keeps.some(k=>k.reviewStartSample<=26258880&&k.reviewEndSample>=26271360));
  const unreviewed=auditSeams({plan:naturalPlan,words:naturalWords,editState:createEditState({policy:{version:'narration-v1'}})});
  assert.ok(unreviewed.fragments.every(f=>f.status==='pending'));
});

test('头尾没有语音锚点也按显式停顿处理，连续删词的内部空隙只有一个删除块',()=>{
  const w=[word('d',1,2),word('a',3,4),word('e',5,5.2),word('f',5.3,6)];
  const p={version:1,initialDeletedWordIds:['d','e','f'],decisions:[decision('head',['d'],null,'a',0,4800),decision('tail',['e','f'],'a',null,4800,0)]};
  const generated=prepareSeams(p,w,['d','e','f'],rate*8).suggestions;
  const plan=compileEdit({words:w,mediaContext:{...mediaContext,review:{sampleRate:rate,decodedSampleCount:rate*8}},audioSuggestions:generated,
    editState:createEditState({initialSuggestedWordDeletes:['d','e','f'],policy:{version:'narration-v1'}})});
  assert.deepEqual(plan.cuts.map(c=>[c.reviewStartSample,c.reviewEndSample]),[[0,139200],[196800,384000]]);
});

test('非法锚点、选择、边界、重叠独立声音和不完整 run 拒绝，不修正',()=>{
  const changes=[p=>p.initialDeletedWordIds.pop(),p=>p.decisions[0].leftWordId='c',p=>p.decisions[0].keepRightSamples=-1,
    p=>p.decisions[0].keepLeftSamples=999999,p=>p.decisions[0].deletedWordIds.pop(),p=>p.decisions.push(structuredClone(p.decisions[0])),
    p=>p.decisions[1].retainedSounds=[{startSample:26241600,endSample:26271360,status:'intentional',reason:'跨词错误'}]];
  for(const change of changes){const p=structuredClone(preparation);change(p);assert.throws(()=>readAudioSuggestionInput(envelope(p),{words,mediaContext,initialSuggestedWordDeletes:selected}));}
  assert.throws(()=>readAudioSuggestionInput(envelope(preparation),{words,mediaContext,initialSuggestedWordDeletes:['d1']}),/绑定|hash/);
  const changedContext=structuredClone(mediaContext);changedContext.offsets.sourceMediaOffset.seconds=.01;
  assert.throws(()=>readAudioSuggestionInput(envelope(preparation),{words,mediaContext:changedContext,initialSuggestedWordDeletes:selected}),/接缝输入 hash/);
  changedContext.offsets.sourceMediaOffset.seconds=0;changedContext.reviewFingerprint={inode:'other'};
  assert.throws(()=>readAudioSuggestionInput(envelope(preparation),{words,mediaContext:changedContext,initialSuggestedWordDeletes:selected}),/接缝输入 hash/);
});

test('恢复词和建议开关独立；边界和手工编辑仅提示复核；快照冻结决定且旧快照不迁移',()=>{
  const suggestions=readAudioSuggestionInput(envelope(preparation),{words,mediaContext,initialSuggestedWordDeletes:selected});
  const planFor=s=>compileEdit({words,mediaContext,audioSuggestions:suggestions,editState:s});
  const restored=transitionEditState(state,{type:'RESTORE_WORD',wordId:'d2'});
  assert.ok(planFor(restored).retainedWordIds.includes('d2'));
  assert.ok(planFor(restored).cuts.some(c=>c.reviewStartSample===24730080));
  const edited=transitionEditState(restored,{type:'SET_AUDIO_SUGGESTION_RANGE',range:{id:'seam-first-right-0',startSample:24743760,endSample:24752880}});
  const audited=auditSeams({plan:planFor(edited),words,editState:edited,preparation,audioSuggestions:suggestions});
  assert.equal(audited.seamReviews[0].status,'user-edited');
  const disabled=transitionEditState(state,{type:'SET_AUDIO_SUGGESTION_ENABLED',id:'seam-second-left-0',enabled:false});
  assert.equal(auditSeams({plan:planFor(disabled),words,editState:disabled,preparation,audioSuggestions:suggestions}).seamReviews[1].status,'user-edited');
  const reviewData={words,asrBreaks:[],initialSuggestedWordDeletes:selected,audioSuggestions:suggestions,seamPreparation:preparation};
  const snapshot=buildEditSnapshot({reviewData,detectedSilence:[],mediaContext,editState:edited,compiledCutPlan:planFor(edited)});
  assert.deepEqual(replayEditSnapshot(snapshot),planFor(edited));assert.deepEqual(snapshot.inputs.seamPreparation,preparation);
  const oldSnapshot=buildEditSnapshot({reviewData:{...reviewData,seamPreparation:undefined,audioSuggestions:old},detectedSilence:[],mediaContext,editState:state,compiledCutPlan:compile(old)});
  assert.equal(Object.hasOwn(oldSnapshot.inputs,'seamPreparation'),false);assert.deepEqual(replayEditSnapshot(oldSnapshot),compile(old));
});

test('未声明孤岛在已解决接缝中报告准备失败，长孤岛也检查',()=>{
  // Independent initial suggestion cuts into the pause left attached to speech.
  const prep=structuredClone(preparation);prep.decisions[0].keepLeftSamples=rate*2;
  const generated=readAudioSuggestionInput(envelope(prep),{words,mediaContext,initialSuggestedWordDeletes:selected});
  const extra=suggestion('independent',504.1,504.5),suggestions=[extra,...generated],plan=compile(suggestions);
  const audit=auditSeams({plan,words,editState:state,preparation:prep,audioSuggestions:suggestions});
  assert.equal(audit.preparationFailures.length,1);assert.ok(audit.fragments[0].endSample-audit.fragments[0].startSample>rate);
  const patched=transitionEditState(state,{type:'ADD_MANUAL_DELETE_RANGE',range:{id:'manual',startSample:24196800,endSample:24216000}});
  assert.equal(auditSeams({plan:compileEdit({words,mediaContext,audioSuggestions:suggestions,editState:patched}),words,editState:patched,preparation:prep,audioSuggestions:suggestions}).seamReviews[0].status,'user-edited');
});

test('接缝元数据之外的用户删词造成孤岛，也定位为用户编辑并追溯 word ID',()=>{
  const w=[word('a',0,1),word('short',2.2,2.24),word('b',4,5)],suggestions=[suggestion('left',1.1,2),suggestion('right',2.5,3.9)];
  const initial=createEditState({policy:{version:'narration-v1'}});
  const edited=transitionEditState(initial,{type:'DELETE_WORD',wordId:'short'});
  const plan=compileEdit({words:w,mediaContext,audioSuggestions:suggestions,editState:edited});
  const audit=auditSeams({plan,words:w,editState:edited,audioSuggestions:suggestions});
  assert.deepEqual(audit.fragments.map(f=>f.status),['user-edited','user-edited']);
  assert.deepEqual(audit.fragments.map(f=>f.editSources.wordIds),[['short'],['short']]);
});
