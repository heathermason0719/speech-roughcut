'use strict';

const FLASH_MAX_BYTES = 100 * 1024 * 1024;
const FLASH_MAX_SECONDS = 2 * 60 * 60;
const STANDARD_MAX_BYTES = 512 * 1024 * 1024;
const STANDARD_MAX_SECONDS = 5 * 60 * 60;

function selectEngineForFormat({ requestedEngine, selectedEngine, extension, sizeBytes = 0, duration = 0 }) {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  let engine = selectedEngine;
  if (engine === 'flash') {
    const formatUnsupported = ext === 'm4a';
    const exceedsFlash = sizeBytes > FLASH_MAX_BYTES || duration > FLASH_MAX_SECONDS;
    if (formatUnsupported || exceedsFlash) {
      if (requestedEngine === 'auto') engine = 'v3-standard';
      else if (formatUnsupported) {
        throw new Error('M4A：火山引擎极速版不支持该格式；请使用 --v3-standard，直通模式不会隐式转码');
      } else {
        throw new Error('火山引擎极速版限制为 2 小时且不超过 100MB；请使用 --v3-standard');
      }
    }
  }
  if (engine === 'v3-standard') {
    if (sizeBytes > STANDARD_MAX_BYTES) throw new Error('火山引擎标准版要求文件不超过 512MB');
    if (duration > STANDARD_MAX_SECONDS) throw new Error('火山引擎标准版要求音频不超过 5 小时');
  }
  return engine;
}

module.exports = {
  FLASH_MAX_BYTES,
  FLASH_MAX_SECONDS,
  STANDARD_MAX_BYTES,
  STANDARD_MAX_SECONDS,
  selectEngineForFormat,
};
