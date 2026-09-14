'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');

const { buildFcpxml } = require('../scripts/lib/fcpxml');

function audioContract(sourcePath, { sampleRate = 44100, channels = 1 } = {}) {
  const tick = seconds => Math.round(seconds * sampleRate);
  const mediaContext = {
    sourcePath,
    exportPath: sourcePath,
    reviewAudioPath: path.join(path.dirname(sourcePath), 'review_audio.mp3'),
    mediaType: 'audio',
    source: {
      sampleRate,
      channels,
      presentationStart: 0,
      rate: 1,
    },
    review: { sampleRate: 48000, decodedSampleCount: 192000 },
    timebase: { kind: 'audio-samples', ticksPerSecond: sampleRate },
    offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } },
  };
  const compiledCutPlan = {
    timebase: { kind: 'audio-samples', ticksPerSecond: sampleRate },
    reviewSampleRate: 48000,
    reviewDecodedSampleCount: 192000,
    sourceOriginTick: 0,
    sourceDurationTicks: 4 * sampleRate,
    keeps: [
      { id: 'keep-0000', sourceStartTick: 0, sourceEndTick: sampleRate, outputStartTick: 0, outputEndTick: sampleRate, reviewStartSample: 0, reviewEndSample: 48000 },
      { id: 'keep-0001', sourceStartTick: 2 * sampleRate, sourceEndTick: 4 * sampleRate, outputStartTick: sampleRate, outputEndTick: 3 * sampleRate, reviewStartSample: 96000, reviewEndSample: 192000 },
    ],
    cuts: [
      { id: 'cut-0000', sourceStartTick: sampleRate, sourceEndTick: 2 * sampleRate, reviewStartSample: 48000, reviewEndSample: 96000 },
    ],
    retainedWordIds: ['word-000000', 'word-000002'],
    titleBlocks: [
      { id: 'title-0000', text: '第一句', keepIndex: 0, sourceStartTick: tick(0.1), sourceEndTick: tick(0.8), outputStartTick: tick(0.1), outputEndTick: tick(0.8), reviewStartSample: 4800, reviewEndSample: 38400, wordIds: ['word-000000'] },
      { id: 'title-0001', text: '第二句', keepIndex: 1, sourceStartTick: tick(2.2), sourceEndTick: tick(2.8), outputStartTick: tick(1.2), outputEndTick: tick(1.8), reviewStartSample: 105600, reviewEndSample: 134400, wordIds: ['word-000002'] },
    ],
    wordDecisions: { initialSuggestedWordDeleteIds: ['word-000001'], finalDeletedWordIds: ['word-000001'] },
  };
  return { mediaContext, compiledCutPlan };
}

function videoContract(sourcePath) {
  return {
    mediaContext: {
      sourcePath,
      exportPath: sourcePath,
      reviewAudioPath: path.join(path.dirname(sourcePath), 'review_audio.mp3'),
      mediaType: 'video',
      source: {
        sampleRate: 48000,
        channels: 2,
        presentationStart: 0,
        rate: 1,
        video: { fpsNum: 30000, fpsDen: 1001, width: 1920, height: 1080, isCfr: true, presentationStart: 0 },
      },
      review: { sampleRate: 48000, decodedSampleCount: 192192 },
      timebase: { kind: 'video-frames', fpsNum: 30000, fpsDen: 1001 },
      offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } },
    },
    compiledCutPlan: {
      timebase: { kind: 'video-frames', fpsNum: 30000, fpsDen: 1001 },
      reviewSampleRate: 48000,
      reviewDecodedSampleCount: 192192,
      sourceOriginTick: 0,
      sourceDurationTicks: 120,
      keeps: [
        { id: 'keep-0000', sourceStartTick: 0, sourceEndTick: 30, outputStartTick: 0, outputEndTick: 30, reviewStartSample: 0, reviewEndSample: 48048 },
        { id: 'keep-0001', sourceStartTick: 60, sourceEndTick: 120, outputStartTick: 30, outputEndTick: 90, reviewStartSample: 96096, reviewEndSample: 192192 },
      ],
      cuts: [{ id: 'cut-0000', sourceStartTick: 30, sourceEndTick: 60, reviewStartSample: 48048, reviewEndSample: 96096 }],
      retainedWordIds: ['word-000000'],
      titleBlocks: [
        { id: 'title-0000', text: 'Output Title', keepIndex: 1, sourceStartTick: 65, sourceEndTick: 75, outputStartTick: 35, outputEndTick: 45, reviewStartSample: 104104, reviewEndSample: 120120, wordIds: ['word-000000'] },
      ],
      wordDecisions: { initialSuggestedWordDeleteIds: [], finalDeletedWordIds: [] },
    },
  };
}

for (const [kind, makeContract] of [['audio', audioContract], ['video', videoContract]]) {
  for (const [label, sourcePath, outputDirectory] of [
    ['source ampersand', '/tmp/a&b.wav', '/tmp/roughcut-export'],
    ['output ampersand', '/tmp/plain.wav', '/tmp/roughcut-a&b'],
    ['mixed special characters', '/tmp/原始 &amp; "引号" #100%.wav', '/tmp/导出 & <test>'],
  ]) {
    test(`${kind} 特殊字符路径经过 XML 解析后仍定位原文件：${label}`, () => {
      const contract = makeContract(sourcePath);
      const before = structuredClone(contract);
      const { xml, outputPath } = buildFcpxml({ ...contract, outputDirectory });
      const attribute = xpath => execFileSync('xmllint', ['--xpath', `string(${xpath})`, '-'], {
        input: xml,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      assert.equal(fileURLToPath(attribute('/fcpxml/resources/asset/@src')), sourcePath);
      assert.equal(fileURLToPath(attribute('/fcpxml/library/@location')), outputPath);
      assert.deepEqual(contract, before);
    });
  }
}

test('纯音频 renderer 保持媒体 ticks，并将音频和 Title 连接到 carrier', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, '原始 语音.wav');
  fs.writeFileSync(source, 'renderer must not probe this file');
  const contract = audioContract(source);
  const { xml, finalKeeps, outputPath } = buildFcpxml({
    ...contract,
    includeTitles: true,
    outputDirectory: root,
  });

  assert.equal(finalKeeps, contract.compiledCutPlan.keeps);
  assert.match(xml, /<asset [^>]*hasAudio="1"[^>]*hasVideo="0"[^>]*audioChannels="1"[^>]*audioRate="44\.1k"/);
  assert.match(xml, /<asset-clip [^>]*offset="158760000\/44100s"[^>]*start="0\/44100s"[^>]*duration="44100\/44100s"/);
  assert.match(xml, /<asset-clip [^>]*offset="158804100\/44100s"[^>]*start="88200\/44100s"[^>]*duration="88200\/44100s"/);
  assert.match(xml, /<sequence duration="90\/30s"/);
  assert.match(xml, /<title [^>]*offset="18006\/5s"[^>]*duration="26460\/44100s"/);
  assert.match(xml, new RegExp(pathToFileURL(source).href.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(xml, /review_audio\.mp3/);
  const xmlFile = path.join(root, 'parse.xml');
  fs.writeFileSync(xmlFile, xml);
  execFileSync('xmllint', ['--noout', xmlFile]);
});

test('非常见源采样率和多声道保留 asset 真实元数据，同时生成 DTD 合法 sequence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-rate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source-16k.wav');
  fs.writeFileSync(source, 'not media');
  const contract = audioContract(source, { sampleRate: 16000, channels: 3 });
  const { xml, outputPath } = buildFcpxml({ ...contract, outputDirectory: root });
  assert.match(xml, /<asset [^>]*audioChannels="3"[^>]*audioRate="16k"/);
  assert.match(xml, /<sequence [^>]*audioLayout="surround" audioRate="48k"/);
  fs.writeFileSync(outputPath, xml);
  const fcpDtd = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_8.dtd';
  if (fs.existsSync(fcpDtd)) {
    execFileSync('xmllint', ['--noout', '--dtdvalid', pathToFileURL(fcpDtd).href, outputPath]);
  }
});

test('CFR 视频 renderer 保持 frame ticks，嵌套 Title 换算回工程后仍在原 output ticks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mov');
  fs.writeFileSync(source, 'not media');
  const contract = videoContract(source);
  const { xml, outputPath } = buildFcpxml({ ...contract, includeTitles: true, outputDirectory: root });
  assert.match(xml, /frameDuration="1001\/30000s" width="1920" height="1080"/);
  assert.match(xml, /<asset [^>]*format="r2"[^>]*hasAudio="1"[^>]*hasVideo="1"[^>]*audioChannels="2"[^>]*audioRate="48k"/);
  assert.match(xml, /<asset-clip [^>]*offset="30030\/30000s"[^>]*start="60060\/30000s"[^>]*duration="60060\/30000s"/);
  assert.match(xml, /<sequence duration="90090\/30000s"/);
  assert.match(xml, /<title [^>]*offset="65065\/30000s"[^>]*duration="10010\/30000s"/);
  fs.writeFileSync(outputPath, xml);
  execFileSync('xmllint', ['--noout', outputPath]);
  const fcpDtd = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_8.dtd';
  if (fs.existsSync(fcpDtd)) {
    execFileSync('xmllint', ['--noout', '--dtdvalid', pathToFileURL(fcpDtd).href, outputPath]);
  }
});

test('非零 source start 的音频保持 sample，首段字幕使用 carrier 本地坐标', () => {
  const contract = audioContract('/tmp/speech-roughcut-subframe.wav');
  const plan = contract.compiledCutPlan;
  plan.keeps = [{
    id: 'keep-0000', sourceStartTick: 52921, sourceEndTick: 88201,
    outputStartTick: 0, outputEndTick: 35280,
    reviewStartSample: 57601, reviewEndSample: 96001,
  }];
  plan.cuts = [
    { sourceStartTick: 0, sourceEndTick: 52921 },
    { sourceStartTick: 88201, sourceEndTick: 176400 },
  ];
  plan.titleBlocks = [{
    id: 'title-0000', text: '首段字幕', keepIndex: 0,
    sourceStartTick: 57331, sourceEndTick: 61741,
    outputStartTick: 4410, outputEndTick: 8820,
    reviewStartSample: 62401, reviewEndSample: 67201,
    wordIds: ['word-000000'],
  }];
  const before = structuredClone(plan);
  const { xml } = buildFcpxml(contract);
  const clip = xml.match(/<asset-clip [^>]*offset="(\d+)\/44100s"[^>]*start="(\d+)\/44100s"[^>]*duration="(\d+)\/44100s"/);
  const title = xml.match(/<title [^>]*offset="([^"]+)"[^>]*duration="([^"]+)"/);
  const seconds = text => { const [n, d = '1'] = text.slice(0, -1).split('/'); return Number(n) / Number(d); };
  assert.deepEqual(clip.slice(1).map(Number), [158760000, 52921, 35280]);
  assert.ok(Math.abs(seconds(title[1]) - 3600 - 0.1) < 1e-9);
  assert.equal(seconds(title[2]), 0.1);
  assert.match(xml, /<sequence duration="24\/30s"/);
  assert.deepEqual(plan, before);
});

test('renderer 拒绝浮点、重叠、无效 timebase 与越界标题，关闭标题不输出 effect', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-fcpxml-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.wav');
  fs.writeFileSync(source, 'not media');
  const contract = audioContract(source);

  const withoutTitles = buildFcpxml({ ...contract, includeTitles: false, outputDirectory: root }).xml;
  assert.doesNotMatch(withoutTitles, /<title |<effect id="r3"/);

  for (const mutate of [
    plan => { plan.keeps[0].sourceStartTick = 0.5; },
    plan => { plan.keeps[1].sourceStartTick = 40000; },
    plan => { plan.timebase.ticksPerSecond = 0; },
    plan => { plan.titleBlocks[0].outputEndTick = 50000; },
  ]) {
    const plan = structuredClone(contract.compiledCutPlan);
    mutate(plan);
    assert.throws(
      () => buildFcpxml({ mediaContext: contract.mediaContext, compiledCutPlan: plan, includeTitles: true, outputDirectory: root }),
      /compiledCutPlan|timebase|title block/,
    );
  }
});

test('FCPXML renderer 源码不含探测、语义重算或二次量化职责', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/lib/fcpxml.js'), 'utf8');
  for (const forbidden of [
    'ffprobe',
    'computeFinalKeeps',
    'selectedIndicesToSegments',
    'protectedSegments',
    'deleteList',
    'cutOpts',
    'toFCPTicks',
    "require('child_process')",
    "require('node:child_process')",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
