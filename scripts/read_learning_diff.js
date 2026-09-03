#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseLearningDiff, serializeLearningDiff } = require('./lib/learning_diff');

function main() {
  const [diffPath, ...extra] = process.argv.slice(2);
  if (!diffPath || extra.length > 0) {
    throw new Error('必须显式提供一个当前格式 learning_diff.json 路径');
  }
  const resolved = path.resolve(diffPath);
  if (!fs.existsSync(resolved)) throw new Error(`learning diff 文件不存在: ${resolved}`);
  process.stdout.write(serializeLearningDiff(parseLearningDiff(fs.readFileSync(resolved, 'utf8'))));
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
}
