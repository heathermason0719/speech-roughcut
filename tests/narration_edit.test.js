'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEditState, transitionEditState } = require('../scripts/lib/edit_state');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { buildEditSnapshot, replayEditSnapshot } = require('../scripts/lib/edit_snapshot');
const rate = 48000;
const mediaContext = {review:{sampleRate:rate,decodedSampleCount:rate*8},
  timebase:{kind:'audio-samples',ticksPerSecond:rate},offsets:{sourceMediaOffset:{seconds:0,status:'verified'}}};
const words = [{id:'a',text:'自然',startSample:0,endSample:rate},
  {id:'b',text:'句子',startSample:rate*3,endSample:rate*4},
  {id:'c',text:'继续',startSample:rate*5,endSample:rate*6}];
const suggestion = (id,groupId,start,end) => ({id,groupId,groupLabel:groupId==='long'?'长停顿':'短停顿',
  startSample:Math.round(start*rate),endSample:Math.round(end*rate),reason:'按本条上下文缩短停顿',basis:'转写与局部波形核验'});
const audioSuggestions=[suggestion('p1','long',1.15,2.85),suggestion('p2','short',4.2,4.8),suggestion('p3','long',6.2,7.8)];
const make = patch => createEditState({...patch,policy:{version:'narration-v1'}});
const input={words,asrBreaks:[],mediaContext,audioSuggestions,
  detectedSilence:[{id:'crossing-pcm',thresholdDb:-35,startSample:0,endSample:rate*8,energy:{maxDb:-90}}]};
const compile=s=>compileEdit({...input,editState:s});
const cuts=p=>p.cuts.map(c=>[c.reviewStartSample,c.reviewEndSample]);

test('逐项音频建议生效；时长、PCM 能量和跨词候选本身不会增加删除',()=>{
  assert.deepEqual(cuts(compile(make())),audioSuggestions.map(p=>[p.startSample,p.endSample]));
  assert.deepEqual(cuts(compileEdit({...input,audioSuggestions:[],editState:make()})),[]);
  assert.deepEqual(cuts(compileEdit({...input,editState:createEditState({policy:{version:'conservative-v1'}})})),[]);
});

test('单条、同类、全部恢复可逆；独立手工与词级决定不受牵连',()=>{
  let s=make({currentDeletedWordIds:['b'],manualDeleteRanges:[{id:'manual',startSample:60000,endSample:70000}]});
  const decisions=compile(s).wordDecisions;
  s=transitionEditState(s,{type:'SET_AUDIO_SUGGESTION_ENABLED',id:'p1',enabled:false});
  assert.deepEqual(cuts(compile(s)),[[60000,70000],[144000,192000],[201600,230400],[297600,374400]]);
  s=transitionEditState(s,{type:'SET_AUDIO_GROUP_ENABLED',groupId:'long',enabled:false});
  assert.equal(compile(s).cuts.length,3);
  s=transitionEditState(s,{type:'SET_ALL_AUDIO_SUGGESTIONS_ENABLED',enabled:false});
  assert.deepEqual(cuts(compile(s)),[[60000,70000],[144000,192000]]);
  s=transitionEditState(s,{type:'SET_ALL_AUDIO_SUGGESTIONS_ENABLED',enabled:true});
  assert.equal(compile(s).cuts.length,3,'开总开关不丢失单条和分组恢复决定');
  assert.deepEqual(compile(s).wordDecisions,decisions);
  assert.equal(s.manualDeleteRanges[0].id,'manual');
});

test('明确修改自动范围可跨词，恢复词不撤掉该修改；关闭该建议恢复原声',()=>{
  let s=transitionEditState(make(),{type:'SET_AUDIO_SUGGESTION_RANGE',range:{id:'p1',startSample:36000,endSample:136800}});
  s=transitionEditState(s,{type:'RESTORE_WORD',wordId:'a'});
  assert.equal(compile(s).cuts[0].reviewStartSample,36000);
  s=transitionEditState(s,{type:'SET_AUDIO_SUGGESTION_ENABLED',id:'p1',enabled:false});
  assert.equal(compile(s).cuts[0].reviewStartSample,201600);
  assert.deepEqual(compile(s).wordDecisions.finalDeletedWordIds,[]);
});

test('批量输入拒绝跨 word、重复身份、越界和缺少理由；修改拒绝未知身份或越界',()=>{
  for(const bad of [
    [suggestion('cross','long',.9,1.8)], [audioSuggestions[0],audioSuggestions[0]],
    [suggestion('outside','long',7,9)], [{...audioSuggestions[0],reason:''}],
  ]) assert.throws(()=>compileEdit({...input,audioSuggestions:bad,editState:make()}),/建议|word|范围|理由/);
  assert.throws(()=>compile(make({disabledAudioSuggestionIds:['missing']})),/未知/);
  assert.throws(()=>compile(make({audioSuggestionRanges:[{id:'p1',startSample:-1,endSample:100}]})),/范围/);
});

test('完整快照包含原始音频建议与用户修改，重放一致且不进入词级 learning',()=>{
  const s=make({disabledAudioSuggestionGroups:['short'],audioSuggestionRanges:[{id:'p1',startSample:60000,endSample:130000}]});
  const snapshot=buildEditSnapshot({reviewData:{words,asrBreaks:[],initialSuggestedWordDeletes:[],audioSuggestions},
    detectedSilence:input.detectedSilence,mediaContext,editState:s,compiledCutPlan:compile(s),includeTitles:true});
  assert.deepEqual(snapshot.inputs.audioSuggestions,audioSuggestions);
  assert.deepEqual(replayEditSnapshot(snapshot),compile(s));
  snapshot.inputs.audioSuggestions[0].startSample+=1;
  assert.throws(()=>replayEditSnapshot(snapshot),/hash/);
});
