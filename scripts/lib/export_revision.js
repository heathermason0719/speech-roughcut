'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fsyncDirectory(fsModule, directory) {
  const handle = fsModule.openSync(directory, 'r');
  try {
    fsModule.fsyncSync(handle);
  } finally {
    fsModule.closeSync(handle);
  }
}

function writeExportRevision(root, writeArtifacts, { fsModule = fs } = {}) {
  const exportsRoot = path.join(root, 'exports');
  fsModule.mkdirSync(exportsRoot, { recursive: true });
  const revision = crypto.randomUUID();
  const temporaryDirectory = path.join(exportsRoot, `.tmp-${revision}`);
  const finalDirectory = path.join(exportsRoot, revision);
  fsModule.mkdirSync(temporaryDirectory);
  try {
    const artifacts = writeArtifacts(temporaryDirectory, finalDirectory);
    if (!artifacts || typeof artifacts.fcpxmlName !== 'string' || typeof artifacts.learningDiffName !== 'string') {
      throw new Error('导出 revision 缺少完整产物');
    }
    for (const name of [artifacts.fcpxmlName, artifacts.learningDiffName]) {
      const file = path.join(temporaryDirectory, name);
      const handle = fsModule.openSync(file, 'r');
      try {
        fsModule.fsyncSync(handle);
      } finally {
        fsModule.closeSync(handle);
      }
    }
    fsyncDirectory(fsModule, temporaryDirectory);
    fsModule.renameSync(temporaryDirectory, finalDirectory);
    fsyncDirectory(fsModule, exportsRoot);
    return {
      revision,
      directory: finalDirectory,
      outputPath: path.join(finalDirectory, artifacts.fcpxmlName),
      learningDiffPath: path.join(finalDirectory, artifacts.learningDiffName),
    };
  } catch (error) {
    fsModule.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function revisionFile(root, revision, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision)) {
    return null;
  }
  if (name !== 'fcpxml') return null;
  try {
    const directory = path.join(root, 'exports', revision);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.fcpxml'));
    return files.length === 1 ? path.join(directory, files[0]) : null;
  } catch (_error) {
    return null;
  }
}

module.exports = { revisionFile, writeExportRevision };
