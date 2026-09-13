'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { claimInvocation, finishInvocation, verifyReviewIdentity } = require('../scripts/lib/invocation');
const { publishTranscript } = require('../scripts/lib/transcript_publication');
const { generateReview } = require('../scripts/generate_review');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { buildFcpxml } = require('../scripts/lib/fcpxml');
const { makeAudio } = require('./helpers/media_fixtures');

// This replacement provider speaks the canonical sample contract directly. It
// has no dependency on a production provider adapter or its response schema.
function fakeProvider() {
  return { version: 1, words: [
    { id: 'phrase-a', text: 'Hello 世界 ', startSample: 4800, endSample: 14400 },
    { id: 'phrase-b', text: 'remove ', startSample: 28800, endSample: 38400 },
    { id: 'phrase-c', text: 'again', startSample: 52800, endSample: 62400 },
  ], asrBreaks: [
    { id: 'asr-break-phrase-a-phrase-b', startSample: 14400, endSample: 28800,
      previousWordId: 'phrase-a', nextWordId: 'phrase-b' },
    { id: 'asr-break-phrase-b-phrase-c', startSample: 38400, endSample: 52800,
      previousWordId: 'phrase-b', nextWordId: 'phrase-c' },
  ] };
}

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speech-canonical-flow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = makeAudio(root, 'wav', { duration: 1.5 });
  const base = path.join(root, 'run');
  const claim = claimInvocation(base, source);
  const credentials = {
    SPEECH_ROUGHCUT_INVOCATION: claim.record.invocationId,
    SPEECH_ROUGHCUT_OWNER: claim.record.owner.token,
  };
  const dir = claim.record.transcribeDir;
  // Use the real prepareMedia CLI with scoped credentials, avoiding mutation of
  // the test runner's environment or interference with parallel test files.
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/prepare_media.js'), source, dir], {
    env: { ...process.env, ...credentials }, stdio: 'pipe',
  });
  const contextFile = path.join(dir, 'media_context.json');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const rawPath = path.join(root, 'fixture-response.json');
  fs.writeFileSync(rawPath, JSON.stringify({ provider: 'independent-fixture-provider', opaque: true }));
  return { root, source, base, claim, credentials, dir, contextFile, context, rawPath };
}

function prepareAnalysis(f) {
  const wordsFile = path.join(f.dir, 'subtitles_words.json');
  const asrBreaksFile = path.join(f.dir, 'asr_breaks.json');
  const analysisDir = path.join(f.base, '2_分析');
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/gen_analysis.js'),
    wordsFile, asrBreaksFile, analysisDir], { stdio: 'pipe' });
  return {
    wordsFile, asrBreaksFile,
    autoSelectedFile: path.join(analysisDir, 'auto_selected.json'),
    contextFile: f.contextFile,
    outDir: path.join(f.base, '3_审核'),
  };
}

test('独立 canonical provider 发布后贯通分析、审核、整数剪辑计划和含 Title 的 FCPXML', async t => {
  const f = setup(t);
  const transcript = fakeProvider();
  publishTranscript({ ...f, transcript });
  finishInvocation(f.claim, 'complete');
  const reviewArgs = prepareAnalysis(f);
  assert.equal(fs.readFileSync(path.join(f.base, '2_分析/analysis.txt'), 'utf8'),
    '0: Hello 世界 remove again');
  const { data, analysis } = await generateReview(reviewArgs);
  assert.deepEqual(data.words, transcript.words);
  assert.deepEqual(data.asrBreaks, transcript.asrBreaks);
  assert.equal(data.invocationId, f.claim.record.invocationId);
  assert.equal(analysis.peaks.decodedSampleCount, f.context.review.decodedSampleCount);
  verifyReviewIdentity(f.contextFile, f.context, data, reviewArgs.outDir);

  const plan = compileEdit({
    words: data.words, asrBreaks: data.asrBreaks,
    detectedSilence: analysis.detectedSilence.filter(item => item.thresholdDb === -35),
    editState: createEditState({
      initialSuggestedWordDeletes: ['phrase-b'], policy: { autoSilenceEnabled: false },
    }),
    mediaContext: data.mediaContext,
  });
  assert.ok(plan.cuts.length > 0);
  assert.ok(plan.keeps.length >= 2);
  assert.deepEqual(plan.titleBlocks.flatMap(block => block.wordIds), ['phrase-a', 'phrase-c']);
  assert.equal(plan.titleBlocks.map(block => block.text).join(''), 'Hello 世界 again');
  for (const keep of plan.keeps) {
    assert.ok(Number.isInteger(keep.sourceStartTick));
    assert.ok(Number.isInteger(keep.sourceEndTick));
  }
  const { xml } = buildFcpxml({
    mediaContext: data.mediaContext, compiledCutPlan: plan, includeTitles: true, outputDirectory: f.root,
  });
  assert.match(xml, /<asset-clip\b/);
  assert.match(xml, /<title\b/);
  assert.match(xml, /Hello 世界 /);
  assert.match(xml, /again/);
  assert.doesNotMatch(xml, /remove /);
  assert.ok(xml.includes(pathToFileURL(f.source).href));
  for (const value of [JSON.stringify(data), JSON.stringify(plan), xml]) {
    assert.doesNotMatch(value, /independent-fixture-provider|"provider"|"opaque"|"start_time"|"utterances"/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'transcript.json'), 'utf8')), transcript);
});

test('已有成功发布拒绝覆盖，全部正式文件和 current 指针保持原始 bytes', t => {
  const f = setup(t);
  publishTranscript({ ...f, transcript: fakeProvider() });
  const names = [
    'volcengine_v3_result.json', 'transcript.json', 'subtitles_words.json', 'asr_breaks.json',
    'result_identity.json', 'transcript_identity.json', 'media_context.json', 'review_audio.mp3',
  ];
  const before = new Map(names.map(name => [name, fs.readFileSync(path.join(f.dir, name))]));
  const invocationBefore = fs.readFileSync(f.claim.file);
  const pointerBefore = fs.readlinkSync(path.join(f.dir, '.transcripts/current'));
  const generationsBefore = fs.readdirSync(path.join(f.dir, '.transcripts')).sort();
  const replacement = fakeProvider();
  replacement.words[0].text = 'replacement';
  fs.writeFileSync(f.rawPath, JSON.stringify({ provider: 'replacement-fixture' }));
  assert.throws(() => publishTranscript({ ...f, transcript: replacement }), /已有正式成功 transcript.*不允许覆盖/);
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.dir, name)), bytes, name);
  assert.deepEqual(fs.readFileSync(f.claim.file), invocationBefore);
  assert.equal(fs.readlinkSync(path.join(f.dir, '.transcripts/current')), pointerBefore);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, '.transcripts')).sort(), generationsBefore);
});

test('即使 transcript 已完整发布，running 或 failed invocation 仍不能生成审核', async t => {
  const f = setup(t);
  publishTranscript({ ...f, transcript: fakeProvider() });
  const args = prepareAnalysis(f);
  await assert.rejects(generateReview(args), /尚未完整完成.*不能进入审核/);
  assert.equal(fs.existsSync(args.outDir), false);
  finishInvocation(f.claim, 'failed');
  await assert.rejects(generateReview(args), /尚未完整完成.*不能进入审核/);
  assert.equal(fs.existsSync(args.outDir), false);
});
