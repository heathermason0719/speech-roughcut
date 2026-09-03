'use strict';

function breakSampleRange(asrBreak, sampleRate) {
  if (Number.isInteger(asrBreak.startSample) && Number.isInteger(asrBreak.endSample)) {
    return { startSample: asrBreak.startSample, endSample: asrBreak.endSample };
  }
  return {
    startSample: Math.round(Number(asrBreak.start) * sampleRate),
    endSample: Math.round(Number(asrBreak.end) * sampleRate),
  };
}

/**
 * ASR 只能标注“这个已有 PCM 静音证据也落在一个 break 搜索窗口里”。
 * 该函数不创建、扩张或合并静音，因此有声 ASR gap 永远不能凭自身成为静音事实。
 */
function annotateCandidateSources(detectedSilence, asrBreaks = [], sampleRate) {
  const windows = asrBreaks
    .map(item => breakSampleRange(item, sampleRate))
    .filter(item => Number.isInteger(item.startSample)
      && Number.isInteger(item.endSample)
      && item.endSample > item.startSample);
  return detectedSilence.map(candidate => {
    const inAsrWindow = windows.some(window => (
      candidate.startSample < window.endSample && candidate.endSample > window.startSample
    ));
    return {
      ...candidate,
      candidateSource: inAsrWindow ? 'asr-window' : 'global',
    };
  });
}

module.exports = { annotateCandidateSources };
