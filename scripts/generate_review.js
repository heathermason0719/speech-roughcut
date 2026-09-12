#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadAndVerifyMediaContext } = require('./lib/media_manifest');
const { analyzeReviewAudio } = require('./lib/review_audio_analysis');
const { acquireReviewWriter, verifyTranscript } = require('./lib/invocation');

const WORKBENCH_SILENCE_THRESHOLDS = [-30, -35, -40, -45];

function readArray(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`找不到${label}文件: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value;
}

async function generateReview({
  wordsFile,
  asrBreaksFile,
  autoSelectedFile,
  contextFile,
  outDir,
}) {
  const resolvedOutDir = path.resolve(outDir);
  const words = readArray(wordsFile, 'words');
  const asrBreaks = readArray(asrBreaksFile, 'asrBreaks');
  if (words.some(word => word && Object.hasOwn(word, 'isGap'))) {
    throw new Error('words 不得包含 gap 伪 word');
  }
  const selected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
  if (!selected || Array.isArray(selected) || !Array.isArray(selected.wordIds)) {
    throw new Error('auto_selected.json 必须使用当前 wordIds 对象格式');
  }
  const knownWordIds = new Set(words.map(word => word.id));
  const initialSuggestedWordDeletes = [...new Set(selected.wordIds.map(String))].sort();
  for (const wordId of initialSuggestedWordDeletes) {
    if (!knownWordIds.has(wordId)) throw new Error(`AI 初选引用未知 word: ${wordId}`);
  }
  const mediaContext = loadAndVerifyMediaContext(contextFile);
  verifyTranscript(contextFile, mediaContext, wordsFile, asrBreaksFile);
  const releaseWriter = acquireReviewWriter(contextFile, mediaContext, resolvedOutDir);
  try {
    fs.mkdirSync(resolvedOutDir, { recursive: true });

    const analysis = await analyzeReviewAudio(mediaContext.reviewAudioPath, {
      asrBreaks,
      silenceThresholds: WORKBENCH_SILENCE_THRESHOLDS,
    });
    if (analysis.peaks.decodedSampleCount !== mediaContext.review.decodedSampleCount) {
      throw new Error('审核分析 sample count 与 media context 不一致');
    }
    const data = {
      ...(mediaContext.invocationId ? { invocationId: mediaContext.invocationId } : {}),
      words,
      asrBreaks,
      initialSuggestedWordDeletes,
      silenceThresholds: WORKBENCH_SILENCE_THRESHOLDS,
      mediaContext,
    };
    fs.writeFileSync(path.join(resolvedOutDir, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
    fs.writeFileSync(
      path.join(resolvedOutDir, 'peaks.json'),
      `${JSON.stringify(analysis.peaks)}\n`,
    );
    fs.writeFileSync(
      path.join(resolvedOutDir, 'detected_silence.json'),
      `${JSON.stringify(analysis.detectedSilence, null, 2)}\n`,
    );
    const templateSource = path.join(__dirname, 'templates', 'review.html');
    if (!fs.existsSync(templateSource)) throw new Error(`找不到模板: ${templateSource}`);
    fs.copyFileSync(templateSource, path.join(resolvedOutDir, 'review.html'));

    console.log(`真实 words: ${words.length}`);
    console.log(`ASR breaks: ${asrBreaks.length}`);
    console.log(`AI 语言初选: ${initialSuggestedWordDeletes.length}`);
    console.log(`📈 sample-domain peaks: ${analysis.peaks.values.length} buckets`);
    console.log(`🔕 PCM 静音证据: ${analysis.detectedSilence.length} 段`);
    console.log('✅ 审核数据准备完成');
    return { data, mediaContext, analysis };
  } finally {
    releaseWriter();
  }
}

if (require.main === module) {
  const [wordsFile, asrBreaksFile, autoSelectedFile, contextFile, outDir = '.'] = process.argv.slice(2);
  if (!wordsFile || !asrBreaksFile || !autoSelectedFile || !contextFile) {
    console.error('用法: node generate_review.js <subtitles_words.json> <asr_breaks.json> <auto_selected.json> <media_context.json> [输出目录]');
    process.exit(1);
  }
  generateReview({ wordsFile, asrBreaksFile, autoSelectedFile, contextFile, outDir }).catch(error => {
    console.error(`❌ 生成审核数据失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { generateReview };
