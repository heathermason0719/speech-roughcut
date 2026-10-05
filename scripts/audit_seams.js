#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { replayEditSnapshot } = require('./lib/edit_snapshot');
const { auditSeams } = require('./lib/seam_preparation');
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('用法: node audit_seams.js <edit_snapshot.json>');
    const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const plan = replayEditSnapshot(snapshot);
    process.stdout.write(`${JSON.stringify(auditSeams({plan,words:snapshot.inputs.words,editState:snapshot.editState,
      preparation:snapshot.inputs.seamPreparation,audioSuggestions:snapshot.inputs.audioSuggestions}),null,2)}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
