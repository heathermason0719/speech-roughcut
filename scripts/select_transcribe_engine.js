#!/usr/bin/env node
'use strict';

const { selectEngineForReview } = require('./lib/transcribe_compat');
const { loadAndVerifyMediaContext } = require('./lib/media_manifest');
const path = require('node:path');
const { selectConfiguredEngine, readSetupCapabilities, assertEngineAvailable } = require('./lib/provider_config');

try {
  const args = process.argv.slice(2);
  let engine;
  if (args[0] === '--configured') {
    const [, requestedEngine, lastEngine, skillDir] = args;
    if (!requestedEngine || lastEngine === undefined || !skillDir) throw new Error('用法: node select_transcribe_engine.js --configured <requested_engine> <last_engine> <skill_dir>');
    engine = selectConfiguredEngine({ requestedEngine, lastEngine, skillDir });
  } else {
    const [requestedEngine, selectedEngine, contextPath, skillDir = path.resolve(__dirname, '..')] = args;
    if (!requestedEngine || !selectedEngine || !contextPath) throw new Error('用法: node select_transcribe_engine.js <requested_engine> <selected_engine> <media_context.json> [skill_dir]');
    const availableEngines = readSetupCapabilities(skillDir);
    assertEngineAvailable(selectedEngine, availableEngines);
    const context = loadAndVerifyMediaContext(contextPath);
    engine = selectEngineForReview({ requestedEngine, selectedEngine, review: context.review });
    if (engine !== selectedEngine && availableEngines && !availableEngines.includes(engine)) {
      throw new Error('审核音频超出极速版上限，当前 setup 未确认标准版可用；请开通标准版并运行 doctor.js --force 后使用 --v3-standard');
    }
    assertEngineAvailable(engine, availableEngines);
  }
  process.stdout.write(`${engine}\n`);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
