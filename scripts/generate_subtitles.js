#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveAsrBreaks, normalizeProviderWords } = require('./lib/transcript_model');

function providerWords(result) {
  const utterances = result && result.result
    ? result.result.utterances
    : result && result.utterances;
  if (!Array.isArray(utterances) || utterances.length === 0) {
    throw new Error('未找到 utterances，响应格式不符合当前火山转写合同');
  }
  return utterances.flatMap(utterance => Array.isArray(utterance.words) ? utterance.words : []);
}

function buildTranscript(result, mediaContext) {
  const sampleRate = Number(mediaContext && mediaContext.review && mediaContext.review.sampleRate);
  const decodedSampleCount = Number(
    mediaContext && mediaContext.review && mediaContext.review.decodedSampleCount,
  );
  const asrOffset = mediaContext && mediaContext.offsets
    && mediaContext.offsets.asrPresentationOffset;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0
      || !Number.isInteger(decodedSampleCount) || decodedSampleCount <= 0) {
    throw new Error('media context 的 review sample clock 无效');
  }
  const words = normalizeProviderWords(providerWords(result), {
    reviewSampleRate: sampleRate,
    asrPresentationOffset: asrOffset,
  });
  for (const word of words) {
    if (word.endSample > decodedSampleCount) {
      throw new Error(`ASR word 超出审核 sample clock: ${word.id}`);
    }
  }
  const asrBreaks = deriveAsrBreaks(words, { minimumBreakSamples: 1 });
  return { words, asrBreaks };
}

function main(argv) {
  const [resultFile, contextFile, outDir] = argv;
  if (!resultFile || !contextFile || !outDir) {
    throw new Error('用法: node generate_subtitles.js <volcengine_v3_result.json> <media_context.json> <输出目录>');
  }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const mediaContext = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const transcript = buildTranscript(result, mediaContext);
  fs.mkdirSync(outDir, { recursive: true });
  const wordsPath = path.join(outDir, 'subtitles_words.json');
  const breaksPath = path.join(outDir, 'asr_breaks.json');
  fs.writeFileSync(wordsPath, `${JSON.stringify(transcript.words, null, 2)}\n`);
  fs.writeFileSync(breaksPath, `${JSON.stringify(transcript.asrBreaks, null, 2)}\n`);
  console.log(`真实 words: ${transcript.words.length}`);
  console.log(`ASR breaks: ${transcript.asrBreaks.length}`);
  console.log(`✅ 已保存 ${wordsPath}`);
  console.log(`✅ 已保存 ${breaksPath}`);
  return transcript;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ 生成字幕失败: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildTranscript, providerWords };
