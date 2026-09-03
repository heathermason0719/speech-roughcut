'use strict';

const FLASH_MAX_BYTES = 100 * 1024 * 1024;
const FLASH_MAX_SECONDS = 2 * 60 * 60;
const STANDARD_MAX_BYTES = 512 * 1024 * 1024;
const STANDARD_MAX_SECONDS = 5 * 60 * 60;

function reviewDuration(review) {
  if (!review || !(review.sampleRate > 0) || !(review.decodedSampleCount > 0)) {
    throw new Error('审核文件缺少 decoded-sample duration');
  }
  return review.decodedSampleCount / review.sampleRate;
}

function selectEngineForReview({ requestedEngine, selectedEngine, review }) {
  if (!review || String(review.extension || '').toLowerCase().replace(/^\./, '') !== 'mp3') {
    throw new Error('实际上传的审核文件必须是 MP3');
  }
  const sizeBytes = Number(review.sizeBytes) || 0;
  const duration = reviewDuration(review);
  let engine = selectedEngine;
  if (engine === 'flash') {
    const exceedsFlash = sizeBytes > FLASH_MAX_BYTES || duration > FLASH_MAX_SECONDS;
    if (exceedsFlash) {
      if (requestedEngine === 'auto') engine = 'v3-standard';
      else throw new Error('火山引擎极速版限制为 2 小时且不超过 100MB；请使用 --v3-standard');
    }
  }
  if (engine === 'v3-standard') {
    if (sizeBytes > STANDARD_MAX_BYTES) throw new Error('火山引擎标准版要求文件不超过 512MB');
    if (duration > STANDARD_MAX_SECONDS) throw new Error('火山引擎标准版要求审核音频不超过 5 小时');
  }
  return engine;
}

module.exports = {
  FLASH_MAX_BYTES,
  FLASH_MAX_SECONDS,
  STANDARD_MAX_BYTES,
  STANDARD_MAX_SECONDS,
  selectEngineForReview,
};
