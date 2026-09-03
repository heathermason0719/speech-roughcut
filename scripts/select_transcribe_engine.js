#!/usr/bin/env node
'use strict';

const { selectEngineForReview } = require('./lib/transcribe_compat');
const { loadAndVerifyMediaContext } = require('./lib/media_manifest');

const [requestedEngine, selectedEngine, contextPath] = process.argv.slice(2);
if (!requestedEngine || !selectedEngine || !contextPath) {
  console.error('用法: node select_transcribe_engine.js <requested_engine> <selected_engine> <media_context.json>');
  process.exit(1);
}

try {
  const context = loadAndVerifyMediaContext(contextPath);
  process.stdout.write(`${selectEngineForReview({
    requestedEngine,
    selectedEngine,
    review: context.review,
  })}\n`);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
