'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { audioSuggestionInputHash, readAudioSuggestionInput } = require('../scripts/lib/audio_suggestion_input');
const words=[{id:'a',text:'旁白',startSample:10,endSample:20}];
const mediaContext={sourceFingerprint:{size:'100',inode:'1'},review:{sampleRate:48000,decodedSampleCount:200}};
const suggestion={id:'s',groupId:'pause',groupLabel:'停顿',startSample:30,endSample:170,reason:'本段停顿过长',basis:'局部波形与转写'};
test('录音建议绑定转写和媒体身份，不可把另一条录音或变更转写的判断误套全片',()=>{
  const envelope={inputHash:audioSuggestionInputHash({words,mediaContext}),suggestions:[suggestion]};
  assert.deepEqual(readAudioSuggestionInput(envelope,{words,mediaContext}),[suggestion]);
  for(const input of [
    {words:[{...words[0],endSample:21}],mediaContext},
    {words,mediaContext:{...mediaContext,sourceFingerprint:{size:'100',inode:'2'}}},
  ]) assert.throws(()=>readAudioSuggestionInput(envelope,input),/hash|身份/);
  assert.throws(()=>readAudioSuggestionInput({...envelope,suggestions:[{...suggestion,startSample:15}]},{words,mediaContext}),/word/);
});
