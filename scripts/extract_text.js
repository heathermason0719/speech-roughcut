#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const wordsFile = process.argv[2];
const breaksFile = process.argv[3];
const outDir = process.argv[4] || '.';

if (!wordsFile || !breaksFile || !fs.existsSync(wordsFile) || !fs.existsSync(breaksFile)) {
  console.error('❌ 用法: node extract_text.js <subtitles_words.json> <asr_breaks.json> [输出目录]');
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const asrBreaks = JSON.parse(fs.readFileSync(breaksFile, 'utf8'));
const paragraphBreaks = new Set(asrBreaks
  .filter(item => item.endSample - item.startSample >= 0.4 * 48000)
  .map(item => item.previousWordId));
const lines = [];
let current = '';
for (const word of words) {
  current += word.text;
  if (paragraphBreaks.has(word.id)) {
    if (current.trim()) lines.push(current.trim());
    current = '';
  }
}
if (current.trim()) lines.push(current.trim());
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'raw_text.txt');
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`✅ 已提取 ${lines.length} 句，保存到 ${outFile}`);
