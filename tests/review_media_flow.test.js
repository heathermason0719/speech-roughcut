'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { parseLearningDiff } = require('../scripts/lib/learning_diff');
const { makeAudio } = require('./helpers/media_fixtures');

const prepareScript = path.resolve(__dirname, '../scripts/prepare_media.js');
const generateReviewScript = path.resolve(__dirname, '../scripts/generate_review.js');
const serverScript = path.resolve(__dirname, '../scripts/review_server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('审核服务器启动超时')), 5000);
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY_PORT=')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`审核服务器提前退出: ${code}\n${output}\n${errors}`));
    });
  });
}

for (const extension of ['mp3', 'm4a', 'wav']) {
  test(`${extension} 审核数据按四模型分离，播放统一 MP3，整数 plan 导出仍引用原始资产`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `speech-roughcut-flow-${extension}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = makeAudio(root, extension, { duration: 1.5 });
    const transcribeDir = path.join(root, '1_转录');
    const reviewDir = path.join(root, '3_审核');
    const wordsFile = path.join(root, 'words.json');
    const breaksFile = path.join(root, 'asr_breaks.json');
    const selectedFile = path.join(root, 'selected.json');
    const words = [
      { id: 'word-000000', text: '测', startSample: 4800, endSample: 14400 },
      { id: 'word-000001', text: '试', startSample: 14400, endSample: 24000 },
    ];
    const asrBreaks = [];
    fs.writeFileSync(wordsFile, JSON.stringify(words));
    fs.writeFileSync(breaksFile, JSON.stringify(asrBreaks));
    fs.writeFileSync(selectedFile, JSON.stringify({ wordIds: ['word-000001'] }));

    execFileSync(process.execPath, [prepareScript, source, transcribeDir]);
    const contextPath = path.join(transcribeDir, 'media_context.json');
    execFileSync(process.execPath, [
      generateReviewScript,
      wordsFile,
      breaksFile,
      selectedFile,
      contextPath,
      reviewDir,
    ]);

    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    const data = JSON.parse(fs.readFileSync(path.join(reviewDir, 'data.json'), 'utf8'));
    assert.deepEqual(data.words, words);
    assert.deepEqual(data.asrBreaks, asrBreaks);
    assert.deepEqual(data.initialSuggestedWordDeletes, ['word-000001']);
    assert.deepEqual(data.mediaContext, context);
    assert.deepEqual(data.silenceThresholds, [-30, -35, -40, -45]);
    assert.equal(JSON.stringify(data).includes('isGap'), false);
    assert.equal(fs.existsSync(path.join(reviewDir, 'media_context.json')), false);
    const peaks = JSON.parse(fs.readFileSync(path.join(reviewDir, 'peaks.json'), 'utf8'));
    assert.equal(peaks.sampleRate, 48000);
    assert.equal(peaks.bucketSamples, 480);
    assert.equal('duration' in peaks, false);
    assert.ok(Array.isArray(peaks.values));
    const detectedSilence = JSON.parse(fs.readFileSync(path.join(reviewDir, 'detected_silence.json'), 'utf8'));
    assert.ok(Array.isArray(detectedSilence));
    assert.ok(detectedSilence.every(item => data.silenceThresholds.includes(item.thresholdDb)));

    const port = await freePort();
    const child = spawn(process.execPath, [serverScript, String(port), contextPath], {
      cwd: reviewDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGTERM'));
    await waitUntilReady(child);

    const mediaResponse = await fetch(`http://127.0.0.1:${port}/video`);
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), fs.readFileSync(context.reviewAudioPath));

    const editState = createEditState({
      initialSuggestedWordDeletes: data.initialSuggestedWordDeletes,
      policy: { autoSilenceEnabled: false },
    });
    const compiledCutPlan = compileEdit({
      words: data.words,
      asrBreaks: data.asrBreaks,
      detectedSilence: detectedSilence.filter(item => item.thresholdDb === -35),
      editState,
      mediaContext: data.mediaContext,
    });
    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/fcpxml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiledCutPlan, includeTitles: false }),
    });
    assert.equal(exportResponse.status, 200);
    const exportResult = await exportResponse.json();
    assert.equal(exportResult.success, true);
    const xml = fs.readFileSync(exportResult.output, 'utf8');
    assert.match(xml, new RegExp(pathToFileURL(source).href.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(xml, /review_audio\.mp3/);
    const learningDiff = parseLearningDiff(fs.readFileSync(exportResult.learningDiff, 'utf8'));
    assert.equal(learningDiff.mediaName, path.basename(source));
    assert.deepEqual(learningDiff.aiOnly, []);
    assert.deepEqual(learningDiff.userOnly, []);
  });
}
