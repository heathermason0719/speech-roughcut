#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function analyzeTranscript(words, asrBreaks, reviewSampleRate = 48000) {
  if (!Array.isArray(words) || !Array.isArray(asrBreaks)) {
    throw new Error('words 与 asrBreaks 必须是独立数组');
  }
  const breaksByPair = new Map(asrBreaks.map(item => [
    `${item.previousWordId}\u0000${item.nextWordId}`,
    item,
  ]));
  const sentences = [];
  let current = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word || typeof word.id !== 'string' || typeof word.text !== 'string') {
      throw new Error(`word 合同无效: ${index}`);
    }
    current.push({ word, index });
    const next = words[index + 1];
    const boundary = next && breaksByPair.get(`${word.id}\u0000${next.id}`);
    const isParagraphBreak = boundary
      && boundary.endSample - boundary.startSample >= Math.round(0.4 * reviewSampleRate);
    if (isParagraphBreak || !next) {
      sentences.push({
        text: current.map(item => item.word.text).join(''),
        startIdx: current[0].index,
        endIdx: current[current.length - 1].index,
        wordIds: current.map(item => item.word.id),
      });
      current = [];
    }
  }
  return { sentences, initialSuggestedWordDeletes: [] };
}

function main(argv) {
  const [wordsFile, breaksFile, outDir] = argv;
  if (!wordsFile || !breaksFile || !outDir) {
    throw new Error('用法: node gen_analysis.js <subtitles_words.json> <asr_breaks.json> <输出目录>');
  }
  const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  const asrBreaks = JSON.parse(fs.readFileSync(breaksFile, 'utf8'));
  const result = analyzeTranscript(words, asrBreaks);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'auto_selected.json'),
    `${JSON.stringify({ wordIds: result.initialSuggestedWordDeletes }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outDir, 'analysis.txt'),
    result.sentences.map((sentence, index) => `${index}: ${sentence.text}`).join('\n'),
  );
  fs.writeFileSync(
    path.join(outDir, 'sentence_map.json'),
    `${JSON.stringify(result.sentences.map(({ startIdx, endIdx, wordIds }) => ({
      startIdx,
      endIdx,
      wordIds,
    })), null, 2)}\n`,
  );
  console.log(`analysis: ${result.sentences.length} 句, 0 个自动 break 删除`);
  return result;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ 生成分析失败: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { analyzeTranscript };
