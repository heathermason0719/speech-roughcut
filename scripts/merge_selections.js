#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function wordIdForIndex(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`无效 word idx: ${index}`);
  return `word-${String(index).padStart(6, '0')}`;
}

function mergeSelections(sentenceMap, speechErrors, initialSelection) {
  if (!initialSelection || Array.isArray(initialSelection)
      || !Array.isArray(initialSelection.wordIds)) {
    throw new Error('auto_selected.json 必须使用当前 wordIds 对象格式');
  }
  if (!speechErrors || Array.isArray(speechErrors)
      || !Array.isArray(speechErrors.delete_sentences)
      || !Array.isArray(speechErrors.delete_idx)) {
    throw new Error('speech_errors.json 必须包含 delete_sentences 与 delete_idx 数组');
  }
  const selected = new Set(initialSelection.wordIds.map(String));
  for (const sentenceIndex of speechErrors.delete_sentences) {
    if (!Number.isInteger(sentenceIndex) || !sentenceMap[sentenceIndex]
        || !Array.isArray(sentenceMap[sentenceIndex].wordIds)) {
      throw new Error(`无效句号: ${sentenceIndex}`);
    }
    sentenceMap[sentenceIndex].wordIds.forEach(id => selected.add(String(id)));
  }
  speechErrors.delete_idx.forEach(index => selected.add(wordIdForIndex(index)));
  return { wordIds: [...selected].sort() };
}

function main(argv) {
  const [mapFile, errorsFile, autoFile] = argv;
  if (!mapFile || !errorsFile || !autoFile) {
    throw new Error('用法: node merge_selections.js <sentence_map.json> <speech_errors.json> <auto_selected.json>');
  }
  const sentenceMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const speechErrors = JSON.parse(fs.readFileSync(errorsFile, 'utf8'));
  const initialSelection = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
  const merged = mergeSelections(sentenceMap, speechErrors, initialSelection);
  fs.writeFileSync(autoFile, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`AI 语言删除建议: ${merged.wordIds.length} 个 word`);
  return merged;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ 合并选择失败: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { mergeSelections, wordIdForIndex };
