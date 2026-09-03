'use strict';

const fs = require('node:fs');
const path = require('node:path');

function removeIfPresent(fsModule, filePath) {
  if (fsModule.existsSync(filePath)) fsModule.unlinkSync(filePath);
}

function writeArtifactPair(artifacts, options = {}) {
  if (!Array.isArray(artifacts) || artifacts.length !== 2) {
    throw new Error('导出产物组必须恰好包含两个文件');
  }
  const fsModule = options.fsModule || fs;
  const nonce = String(options.nonce || `${process.pid}-${Date.now()}`)
    .replace(/[^A-Za-z0-9_-]/g, '_');
  const normalized = artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact.path !== 'string' || artifact.path.length === 0
        || (!Buffer.isBuffer(artifact.data) && typeof artifact.data !== 'string')) {
      throw new Error(`导出产物 ${index + 1} 无效`);
    }
    const targetPath = path.resolve(artifact.path);
    return {
      targetPath,
      data: artifact.data,
      temporaryPath: `${targetPath}.tmp-${nonce}-${index}`,
      rollbackPath: `${targetPath}.rollback-${nonce}-${index}`,
    };
  });
  if (normalized[0].targetPath === normalized[1].targetPath) {
    throw new Error('导出产物路径不能重复');
  }
  const snapshots = normalized.map(artifact => ({
    existed: fsModule.existsSync(artifact.targetPath),
    data: fsModule.existsSync(artifact.targetPath)
      ? fsModule.readFileSync(artifact.targetPath)
      : null,
  }));

  try {
    for (const artifact of normalized) {
      fsModule.writeFileSync(artifact.temporaryPath, artifact.data, { flag: 'wx' });
    }
    for (const artifact of normalized) {
      fsModule.renameSync(artifact.temporaryPath, artifact.targetPath);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of normalized) {
      try {
        removeIfPresent(fsModule, artifact.temporaryPath);
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError.message);
      }
    }
    normalized.forEach((artifact, index) => {
      try {
        removeIfPresent(fsModule, artifact.rollbackPath);
        if (snapshots[index].existed) {
          fsModule.writeFileSync(artifact.rollbackPath, snapshots[index].data, { flag: 'wx' });
          fsModule.renameSync(artifact.rollbackPath, artifact.targetPath);
        } else {
          removeIfPresent(fsModule, artifact.targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      } finally {
        try {
          removeIfPresent(fsModule, artifact.rollbackPath);
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError.message);
        }
      }
    });
    if (rollbackErrors.length) {
      error.message = `${error.message}; 产物组回滚不完整: ${rollbackErrors.join('; ')}`;
    }
    throw error;
  }
}

module.exports = { writeArtifactPair };
