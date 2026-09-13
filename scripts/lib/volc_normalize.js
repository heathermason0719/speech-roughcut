'use strict';

const { deriveAsrBreaks, normalizeProviderWords } = require('./transcript_model');
const { validateCanonicalTranscript } = require('./canonical_transcript');

// Display separators have no independent audio interval. Attach them to a real
// word so consumers that concatenate word.text retain the recognized display.
function appendSeparator(words, separator, pending) {
  if (words.length) words[words.length - 1].text += separator;
  else pending.text += separator;
}

function alignDisplay(words, display, label) {
  if (display !== undefined && typeof display !== 'string') throw new Error(`${label} 格式无效`);
  if (!display || !display.trim()) return words;
  let cursor = 0;
  for (let index = 0; index < words.length; index += 1) {
    const text = words[index].text.trim();
    const start = display.indexOf(text, cursor);
    const separator = start < 0 ? '' : display.slice(cursor, start);
    if (start < 0 || !/^[\s\p{P}]*$/u.test(separator)) {
      throw new Error(`${label} 与 timed words 无法对齐，存在遗漏文本`);
    }
    words[index].text = (index === 0 ? separator : '') + text;
    if (index > 0) words[index - 1].text += separator;
    cursor = start + text.length;
  }
  const trailing = display.slice(cursor);
  if (!/^[\s\p{P}]*$/u.test(trailing)) {
    throw new Error(`${label} 与 timed words 无法对齐，存在遗漏文本`);
  }
  if (words.length) words[words.length - 1].text += trailing;
  return words;
}

function utteranceWords(utterance) {
  if (!utterance || typeof utterance !== 'object'
      || (utterance.text !== undefined && typeof utterance.text !== 'string')
      || (utterance.words !== undefined && !Array.isArray(utterance.words))) {
    throw new Error('火山 utterance/text/words 格式无效');
  }
  const words = [];
  const pending = { text: '' };
  for (const item of utterance.words || []) {
    if (!item || typeof item.text !== 'string') throw new Error('火山 word 文本格式无效');
    if (!item.text.trim()) {
      appendSeparator(words, item.text, pending);
      continue;
    }
    for (const key of ['start_time', 'end_time']) {
      const value = item[key];
      if (!((typeof value === 'number' || (typeof value === 'string' && value.trim()))
          && Number.isFinite(Number(value)))) {
        throw new Error(`provider 非空 word 时间无效: ${item.text}`);
      }
    }
    words.push({ text: pending.text + item.text, start_time: item.start_time, end_time: item.end_time });
    pending.text = '';
  }
  if (!words.length) {
    if (utterance.text && utterance.text.trim()) {
      throw new Error('非空识别句缺少可表达的 timed words');
    }
    return [];
  }
  return alignDisplay(words, utterance.text, 'utterance.text');
}

function normalizeVolcResult(raw, mediaContext) {
  const result = raw && raw.result ? raw.result : raw;
  const utterances = result && result.utterances;
  if (!Array.isArray(utterances) || utterances.length === 0) {
    throw new Error('未找到 utterances，响应格式不符合当前火山转写合同');
  }
  const providerWords = alignDisplay(utterances.flatMap(utteranceWords), result.text, 'result.text');
  const words = normalizeProviderWords(providerWords, {
    reviewSampleRate: mediaContext && mediaContext.review && mediaContext.review.sampleRate,
    asrPresentationOffset: mediaContext && mediaContext.offsets
      && mediaContext.offsets.asrPresentationOffset,
  });
  return validateCanonicalTranscript({
    version: 1,
    words,
    asrBreaks: deriveAsrBreaks(words, { minimumBreakSamples: 1 }),
  }, mediaContext);
}

module.exports = { normalizeVolcResult };
