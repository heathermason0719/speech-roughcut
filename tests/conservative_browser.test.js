'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeMarkerWav } = require('./helpers/media_fixtures');
const { openChrome, delay, stopChild, freePort, waitUntilReady } = require('./helpers/review_browser');

test('保守工作台的实际点击、范围操作、候选导航和唯一计划', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roughcut-conservative-'));
  let chrome, server;
  t.after(async () => { if (chrome) await chrome.close(); await stopChild(server);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const repo = path.resolve(__dirname, '..');
  const source = makeMarkerWav(root, { duration: 6 });
  const transcribe = path.join(root, '1_转录'), review = path.join(root, '3_审核');
  execFileSync(process.execPath, [path.join(repo, 'scripts/prepare_media.js'), source, transcribe]);
  const contextFile = path.join(transcribe, 'media_context.json');
  const words = [
    { id: 'a', text: '上一句', startSample: 4800, endSample: 38400 },
    { id: 'b', text: '点击这里', startSample: 62400, endSample: 72000 },
    { id: 'c', text: '保留', startSample: 158400, endSample: 182400 },
    { id: 'd', text: '结尾', startSample: 240000, endSample: 264000 },
  ];
  const asrBreaks = words.slice(0, -1).map((w,i) => ({ id: `asr-${i}`, previousWordId: w.id,
    nextWordId: words[i+1].id, startSample: w.endSample, endSample: words[i+1].startSample }));
  for (const [name,data] of [['words',words],['breaks',asrBreaks],['selected',{wordIds:['a','b']}]]) {
    fs.writeFileSync(path.join(root, name+'.json'), JSON.stringify(data));
  }
  execFileSync(process.execPath, [path.join(repo, 'scripts/generate_review.js'),
    ...['words','breaks','selected'].map(n=>path.join(root,n+'.json')), contextFile, review]);
  const legacyData=JSON.parse(fs.readFileSync(path.join(review,'data.json'),'utf8'));
  legacyData.editPolicyVersion='conservative-v1'; // Existing conservative sessions keep their contract.
  fs.writeFileSync(path.join(review,'data.json'),JSON.stringify(legacyData));
  fs.writeFileSync(path.join(review, 'detected_silence.json'), JSON.stringify([
    {id:'pcm-cross',thresholdDb:-35,startSample:57600,endSample:144000,energy:{maxDb:-60}},
  ]));
  const port = await freePort();
  server = spawn(process.execPath, [path.join(repo, 'scripts/review_server.js'), String(port), contextFile],
    { cwd:review, stdio:['ignore','pipe','pipe'] });
  await waitUntilReady(server);
  chrome = await openChrome(`http://127.0.0.1:${port}/`, path.join(root,'chrome'));
  for(let n=0;n<500;n++) {
    const s=await chrome.evaluate('({ready:window.__reviewTest?.ready,error:window.__reviewTest?.error})');
    if(s.error) assert.fail(s.error); if(s.ready) break;
    if(n===499) assert.fail('初始化超时'); await delay(20);
  }

  await t.test('点击即自动播放，焦点不随前文删除状态变化', async () => {
    const probe = () => chrome.evaluate(`(() => {
      document.querySelector('[data-word-id="b"]').click();
      const p=document.getElementById('player'); const result={time:p.currentTime,paused:p.paused}; p.pause(); return result;
    })()`);
    assert.deepEqual(await probe(), { time:1.3, paused:false });
    await delay(100);
    assert.equal(await chrome.evaluate('__reviewTest.error'),null);
    await chrome.evaluate("__reviewTest.dispatch({type:'RESTORE_WORD',wordId:'a'})");
    assert.deepEqual(await probe(), { time:1.3, paused:false });
  });

  await t.test('新会话默认保守，候选显示与定位都不提交删音', async () => {
    const initial=await chrome.evaluate(`({state:__reviewTest.getEditState(),plan:__reviewTest.getPlan(),
      chips:document.querySelectorAll('.paragraph-body .gap').length,
      paddingVisible:!!document.getElementById('knob-padstart').getClientRects().length})`);
    assert.equal(initial.state.policy.version,'conservative-v1');
    assert.equal(initial.chips,0); assert.equal(initial.paddingVisible,false);
    const navigation=await chrome.evaluate(`(() => {
      const before=JSON.stringify(__reviewTest.getPlan());
      const marker=document.querySelector('.pause-marker'); marker.click();
      const selected=document.getElementById('rangeStart').value;
      document.getElementById('showShortPauses').click();
      return {same:before===JSON.stringify(__reviewTest.getPlan()),selected,
        sourceButtons:document.querySelectorAll('#pauseEvidence button').length,
        markers:document.querySelectorAll('.pause-marker').length};
    })()`);
    assert.equal(navigation.same,true); assert.equal(navigation.selected,'');
    assert.equal(navigation.sourceButtons,0); assert.equal(navigation.markers,2);
  });

  await t.test('无 word / PCM 的声音能通过真实控件选择、试听、删除和撤销', async () => {
    const result=await chrome.evaluate(`(() => {
      const before=JSON.stringify(__reviewTest.getPlan());
      const set=(id,value)=>{const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));};
      set('rangeStart','4.1'); set('rangeEnd','4.4');
      const draftOnly=before===JSON.stringify(__reviewTest.getPlan());
      waveZoomFit();
      document.getElementById('auditionRange').click();
      const p=document.getElementById('player');const audition={time:p.currentTime,paused:p.paused};p.pause();
      const waveform=__reviewTest.getWaveViewport();
      const decisions=JSON.stringify(__reviewTest.getPlan().wordDecisions);
      document.getElementById('deleteRange').click();
      const failure=__reviewTest.lastEditError;
      const cut=__reviewTest.getPlan().cuts.some(c=>c.reviewStartSample===196800&&c.reviewEndSample===211200);
      const state=__reviewTest.getEditState();const sameDecisions=decisions===JSON.stringify(__reviewTest.getPlan().wordDecisions);
      __reviewTest.undo();const undone=before===JSON.stringify(__reviewTest.getPlan());__reviewTest.redo();
      const redone=__reviewTest.getEditState().manualDeleteRanges[0]?.id===state.manualDeleteRanges[0]?.id;
      return {draftOnly,audition,waveform,cut,sameDecisions,undone,redone,consistent:__reviewTest.getConsumerConsistency().sameObject,
        ranges:state.manualDeleteRanges, error:failure, mediaError:__reviewTest.error};
    })()`);
    assert.equal(result.ranges.length, 1, JSON.stringify(result));
    assert.equal(result.cut,true,JSON.stringify(result));
    assert.equal(result.error,null); assert.equal(result.mediaError,null);
    assert.ok(Math.abs(result.audition.time-4.1) < 1/48000);
    for (const key of ['draftOnly','sameDecisions','undone','redone','consistent']) assert.equal(result[key],true,key);
    assert.equal(result.audition.paused,false);
    assert.ok(result.waveform.scale>1, '试听精确选区应联动局部波形，方便继续调整边界');
  });

  await t.test('非法选区不修改状态；独立删音覆盖恢复词且能单独取消', async () => {
    const result=await chrome.evaluate(`(() => {
      const set=(a,b)=>{for(const [id,value] of [['rangeStart',a],['rangeEnd',b]]){
        const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}};
      const before=JSON.stringify(__reviewTest.getEditState());set('5','7');document.getElementById('deleteRange').click();
      const rejected=before===JSON.stringify(__reviewTest.getEditState());
      __reviewTest.dispatch({type:'RESTORE_WORD',wordId:'b'});
      set('1.35','1.45');document.getElementById('deleteRange').click();
      const status=document.querySelector('[data-word-id="b"]').dataset.audioCoverage;
      const item=[...document.querySelectorAll('[data-range-id]')].find(n=>n.dataset.startSample==='64800');
      item.querySelector('[data-action="remove"]').click();
      return {rejected,status,remaining:__reviewTest.getEditState().manualDeleteRanges.map(r=>[r.startSample,r.endSample])};
    })()`);
    assert.deepEqual(result,{rejected:true,status:'partial',remaining:[[196800,211200]]});
  });

  await t.test('Shift 拖选以鼠标像素精度建立草稿，不改变剪辑计划', async () => {
    const result=await chrome.evaluate(`(() => {
      waveZoomFit();const before=JSON.stringify(__reviewTest.getPlan());
      const canvas=document.getElementById('waveCanvas'),r=canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,shiftKey:true,clientX:r.left+r.width/3,clientY:r.top+5}));
      document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,shiftKey:true,clientX:r.left+2*r.width/3,clientY:r.top+5}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
      return {start:document.getElementById('rangeStart').value,end:document.getElementById('rangeEnd').value,
        same:before===JSON.stringify(__reviewTest.getPlan()),pixelSeconds:6/r.width};
    })()`);
    assert.ok(Math.abs(Number(result.start.split(':')[1])-2)<=result.pixelSeconds+1/48000);
    assert.ok(Math.abs(Number(result.end.split(':')[1])-4)<=result.pixelSeconds+1/48000);
    assert.equal(result.same,true);
  });

  await t.test('词首被手工范围切掉时，点击该词仍从词首试听原声', async () => {
    const result=await chrome.evaluate(`(() => {
      __reviewTest.dispatch({type:'ADD_MANUAL_DELETE_RANGE',range:{id:'partial-onset',startSample:62400,endSample:62880}});
      document.querySelector('[data-word-id="b"]').click();
      const seek=__reviewTest.processPlaybackSample(62400,false);
      const time=document.getElementById('player').currentTime;
      document.getElementById('player').pause();
      __reviewTest.undo();return {seek,time};
    })()`);
    assert.deepEqual(result,{seek:null,time:1.3});
  });

  await t.test('快捷键不被焦点抢走，按住不连发；时间输入的删除仍编辑数字', async () => {
    const key = async (code, key, extra = {}) => {
      await chrome.send('Input.dispatchKeyEvent', { type:'keyDown',code,key,...extra });
      await chrome.send('Input.dispatchKeyEvent', { type:'keyUp',code,key,...extra });
    };
    for (const id of ['playBtn','auditionRange','speed','themeSelect','showShortPauses','rangeStart']) {
      await chrome.evaluate(`(() => { const p=document.getElementById('player');p.pause();p.currentTime=1;
        const n=document.getElementById('${id}');n.disabled=false;n.focus(); })()`);
      await key('Space',' ');
      assert.equal(await chrome.evaluate('document.getElementById("player").paused'), false, id);
      await chrome.send('Input.dispatchKeyEvent', {type:'keyDown',code:'Space',key:' ',autoRepeat:true});
      assert.equal(await chrome.evaluate('document.getElementById("player").paused'), false, '重复 Space 不再次切换');
      await key('Space',' ');
      assert.equal(await chrome.evaluate('document.getElementById("player").paused'), true, id);
    }
    await chrome.evaluate(`(() => {clearAll();document.getElementById('clearRange').click();
      document.getElementById('player').currentTime=4.1;document.getElementById('playBtn').focus();})()`);
    await key('KeyI','i');
    await chrome.evaluate('document.getElementById("player").currentTime=4.4');
    await key('KeyO','o');
    assert.deepEqual(await chrome.evaluate(`['rangeStart','rangeEnd'].map(id=>document.getElementById(id).value)`),['0:04.1','0:04.4']);
    await key('Backspace','Backspace');
    const range = await chrome.evaluate('__reviewTest.getEditState().manualDeleteRanges[0]');
    assert.deepEqual([range.startSample,range.endSample],[196800,211200]);
    await key('Backspace','Backspace');
    assert.equal(await chrome.evaluate('__reviewTest.getEditState().manualDeleteRanges.length'),1,'空选区无动作');
    await chrome.evaluate(`(() => {const n=document.getElementById('rangeStart');n.value='4.12';n.focus();n.setSelectionRange(4,4);})()`);
    await key('Backspace','Backspace',{windowsVirtualKeyCode:8});
    assert.equal(await chrome.evaluate('document.getElementById("rangeStart").value'),'4.1');
    assert.equal(await chrome.evaluate('__reviewTest.getEditState().manualDeleteRanges.length'),1);
    const guarded=await chrome.evaluate(`(() => {
      document.getElementById('playBtn').focus();const p=document.getElementById('player');p.pause();
      for(const options of [{isComposing:true},{ctrlKey:true},{metaKey:true},{altKey:true}])
        document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true,cancelable:true,...options}));
      return p.paused;
    })()`);
    assert.equal(guarded,true);
  });
});
