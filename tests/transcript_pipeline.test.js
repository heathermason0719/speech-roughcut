'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const generateSubtitles = path.resolve(__dirname, '../scripts/generate_subtitles.js');
const genAnalysis = path.resolve(__dirname, '../scripts/gen_analysis.js');
const mergeSelections = path.resolve(__dirname, '../scripts/merge_selections.js');

test('转写产物只含真实 words，asrBreaks 独立且 AI 初选不自动删除 break', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resultFile = path.join(root, 'result.json');
  const contextFile = path.join(root, 'media_context.json');
  const transcriptDir = path.join(root, '1_转录');
  const analysisDir = path.join(root, '2_分析');
  fs.mkdirSync(transcriptDir);
  fs.writeFileSync(resultFile, JSON.stringify({
    result: {
      utterances: [{
        words: [
          { text: '甲', start_time: 100, end_time: 250 },
          { text: ' ', start_time: -1, end_time: -1 },
          { text: '乙', start_time: 700, end_time: 900 },
          { text: '丙', start_time: 950, end_time: 1100 },
        ],
      }],
    },
  }));
  fs.writeFileSync(contextFile, JSON.stringify({
    review: { sampleRate: 48000, decodedSampleCount: 96000 },
    offsets: { asrPresentationOffset: { seconds: 0.05, status: 'pending_user_validation' } },
  }));

  execFileSync(process.execPath, [generateSubtitles, resultFile, contextFile, transcriptDir]);
  const wordsFile = path.join(transcriptDir, 'subtitles_words.json');
  const breaksFile = path.join(transcriptDir, 'asr_breaks.json');
  const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  const breaks = JSON.parse(fs.readFileSync(breaksFile, 'utf8'));

  assert.deepEqual(words.map(word => word.id), ['word-000000', 'word-000001', 'word-000002']);
  assert.deepEqual(words.map(word => [word.startSample, word.endSample]), [
    [2400, 9600],
    [31200, 40800],
    [43200, 50400],
  ]);
  assert.equal(words.some(word => Object.hasOwn(word, 'isGap')), false);
  assert.equal(breaks.length, 2);
  assert.equal(breaks[0].previousWordId, 'word-000000');
  assert.equal(breaks[0].nextWordId, 'word-000001');

  execFileSync(process.execPath, [genAnalysis, wordsFile, breaksFile, analysisDir]);
  const initial = JSON.parse(fs.readFileSync(path.join(analysisDir, 'auto_selected.json'), 'utf8'));
  const sentenceMap = JSON.parse(fs.readFileSync(path.join(analysisDir, 'sentence_map.json'), 'utf8'));
  assert.deepEqual(initial, { wordIds: [] });
  assert.deepEqual(sentenceMap.map(item => item.wordIds), [
    ['word-000000'],
    ['word-000001', 'word-000002'],
  ]);

  const errorsFile = path.join(analysisDir, 'speech_errors.json');
  fs.writeFileSync(errorsFile, JSON.stringify({ delete_sentences: [1], delete_idx: [0] }));
  execFileSync(process.execPath, [
    mergeSelections,
    path.join(analysisDir, 'sentence_map.json'),
    errorsFile,
    path.join(analysisDir, 'auto_selected.json'),
  ]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(analysisDir, 'auto_selected.json'), 'utf8')),
    { wordIds: ['word-000000', 'word-000001', 'word-000002'] },
  );
});

test('merge_selections 明确拒绝纯数组旧选择格式', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-transcript-old-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const map = path.join(root, 'sentence_map.json');
  const errors = path.join(root, 'speech_errors.json');
  const selected = path.join(root, 'auto_selected.json');
  fs.writeFileSync(map, JSON.stringify([{ startIdx: 0, endIdx: 0, wordIds: ['word-000000'] }]));
  fs.writeFileSync(errors, JSON.stringify({ delete_sentences: [], delete_idx: [] }));
  fs.writeFileSync(selected, '[]');
  assert.throws(
    () => execFileSync(process.execPath, [mergeSelections, map, errors, selected], { stdio: 'pipe' }),
    error => /auto_selected\.json 必须使用当前 wordIds 对象格式/.test(String(error.stderr)),
  );
});
