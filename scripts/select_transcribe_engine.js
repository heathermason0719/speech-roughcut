#!/usr/bin/env node
'use strict';

const { selectEngineForFormat } = require('./lib/transcribe_compat');
const { probeMedia } = require('./lib/media_manifest');

const [requestedEngine, selectedEngine, mediaPath] = process.argv.slice(2);
if (!requestedEngine || !selectedEngine || !mediaPath) {
  console.error('用法: node select_transcribe_engine.js <requested_engine> <selected_engine> <analysis_media>');
  process.exit(1);
}

try {
  const media = probeMedia(mediaPath);
  process.stdout.write(selectEngineForFormat({
    requestedEngine,
    selectedEngine,
    extension: media.extension,
    sizeBytes: media.sizeBytes,
    duration: media.duration,
  }) + '\n');
} catch (error) {
  console.error('❌ ' + error.message);
  process.exit(1);
}
