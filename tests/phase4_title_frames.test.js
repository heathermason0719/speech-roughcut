'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { buildFcpxml } = require('../scripts/lib/fcpxml');

function fixture({ rate = 44100, keepStart = 83520, keepEnd = 417600,
  wordRanges = [[97920, 132480], [167040, 205440], [247680, 403200]] } = {}) {
  const mediaContext = { sourcePath: '/tmp/title-frame-source.wav', exportPath: '/tmp/title-frame-source.wav',
    mediaType: 'audio', source: { sampleRate: rate, channels: 1, rate: 1, presentationStart: 0 },
    review: { sampleRate: 48000, decodedSampleCount: 480000 },
    timebase: { kind: 'audio-samples', ticksPerSecond: rate },
    offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } } };
  const words = wordRanges.map(([startSample, endSample], i) => ({ id: `w${i}`, text: `字幕${i}`, startSample, endSample }));
  const compiledCutPlan = compileEdit({ mediaContext, words,
    asrBreaks: words.slice(1).map((w, i) => ({ previousWordId: words[i].id, nextWordId: w.id,
      startSample: words[i].endSample, endSample: w.startSample })),
    editState: createEditState({ policy: { autoSilenceEnabled: false },
      manualDeleteRanges: [{ startSample: 0, endSample: keepStart }, { startSample: keepEnd, endSample: 480000 }] }) });
  return { mediaContext, compiledCutPlan };
}
function rational(s) {
  const [n, d = '1'] = s.slice(0, -1).split('/');
  return Number(n) / Number(d);
}
function attrs(s) { return Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]])); }
function titles(xml) {
  const gap = xml.match(/<gap\b([^>]*)>([\s\S]*?)<\/gap>/);
  assert.ok(gap, 'audio must use a Primary Storyline carrier');
  const parent = attrs(gap[1]);
  assert.equal(parent.start, '3600s');
  assert.equal((gap[2].match(/<asset-clip /g) || []).length,
    (gap[2].match(/<asset-clip [^>]*lane="-1"[^>]*\/>/g) || []).length,
    'audio clips are connected siblings, not Title parents');
  return [...gap[2].matchAll(/<title\b([^>]*)>/g)].map(m => {
    const a = attrs(m[1]);
    assert.ok(Math.abs(rational(a.offset) * 30 - Math.round(rational(a.offset) * 30)) < 1e-8);
    assert.ok(Math.abs(rational(a.duration) * 30 - Math.round(rational(a.duration) * 30)) < 1e-8);
    const start = rational(parent.offset) + rational(a.offset) - rational(parent.start);
    return { ...a, start, end: start + rational(a.duration), parent };
  });
}

function unchangedAudio(xml) {
  return xml.replace(/\buid="[0-9a-f-]+"/g, 'uid="UUID"')
    .replace(/<title\b[\s\S]*?<\/title>/g, '');
}

test('FCP 实际告警数值：Title 与音频连接到 carrier，局部和 output 均整帧，音频及 plan 不变', () => {
  const f = fixture();
  const before = structuredClone(f);
  const result = buildFcpxml(f);
  const observed = titles(result.xml);
  // Hand-derived from the screenshot: output [0.30,1.02], [1.74,2.54], [3.42,6.66].
  const expectedFrames = [[9, 31], [52, 76], [103, 200]];
  assert.equal(observed.length, 3);
  observed.forEach((title, i) => {
    assert.ok(Math.abs(title.start * 30 - expectedFrames[i][0]) < 1e-8);
    assert.ok(Math.abs(title.end * 30 - expectedFrames[i][1]) < 1e-8);
    assert.equal(title.name, `字幕${i}`);
    assert.equal(title.ref, 'r3');
  });
  assert.match(result.xml, /duration="306936\/44100s"/);
  assert.deepEqual(f, before);
  assert.deepEqual(result.finalKeeps, before.compiledCutPlan.keeps);
});

test('Title 约束到所属 keep 的完整 sequence 帧，保留原文和可编辑结构', () => {
  const f = fixture({ keepStart: 1, keepEnd: 4801, wordRanges: [[1, 4801]] });
  // Shift this keep away from output zero: a preceding 1001-sample keep puts
  // both its start and end off-frame. Preserve integer audio cuts verbatim.
  const p = f.compiledCutPlan, rate = 44100;
  const k = p.keeps[0];
  p.keeps = [{ ...k, id: 'prior', sourceStartTick: 0, sourceEndTick: 1001,
    outputStartTick: 0, outputEndTick: 1001, reviewStartSample: 0, reviewEndSample: 1090 },
  { ...k, sourceStartTick: 2000, sourceEndTick: 6410, outputStartTick: 1001, outputEndTick: 5411,
    reviewStartSample: 2177, reviewEndSample: 6977 }];
  p.cuts = [{ sourceStartTick: 1001, sourceEndTick: 2000 }, { sourceStartTick: 6410, sourceEndTick: p.sourceDurationTicks }];
  p.titleBlocks = [{ ...p.titleBlocks[0], keepIndex: 1, sourceStartTick: 2000, sourceEndTick: 6410,
    outputStartTick: 1001, outputEndTick: 5411, reviewStartSample: 2177, reviewEndSample: 6977 }];
  const before = structuredClone(p);
  const xml = buildFcpxml(f).xml;
  const title = titles(xml)[0];
  assert.ok(Math.abs(title.start - 1 / 30) < 1e-8);
  assert.ok(Math.abs(title.end - 3 / 30) < 1e-8);
  assert.ok(title.start >= 1001 / rate && title.end <= 5411 / rate);
  assert.match(xml, /<text><text-style ref="ts1">字幕0<\/text-style><\/text>/);
  assert.match(xml, /Basic Title\.moti/);
  assert.deepEqual(p, before);
});

test('无法容纳正长度整帧 Title 时明确拒绝，不静默丢字或改音频', () => {
  const f = fixture({ keepStart: 48000, keepEnd: 48001, wordRanges: [[48000, 48001]] });
  const before = structuredClone(f);
  assert.throws(() => buildFcpxml(f), /Title.*整帧/);
  assert.doesNotThrow(() => buildFcpxml({ ...f, includeTitles: false }));
  assert.deepEqual(f, before);
});

test('非 30 整除采样率仍生成精确有理数帧时码', () => {
  const f = fixture({ rate: 16000, keepStart: 48001, keepEnd: 144001, wordRanges: [[59520, 83520]] });
  const xml = buildFcpxml(f).xml;
  const title = titles(xml)[0];
  assert.ok(Math.abs(title.start * 30 - 7) < 1e-8);
  assert.ok(Math.abs(title.end * 30 - 22) < 1e-8);
  assert.equal(title.offset, '108007/30s');
  const before = structuredClone(f);
  assert.equal(unchangedAudio(buildFcpxml(f).xml), unchangedAudio(xml));
  assert.deepEqual(f, before);
});
