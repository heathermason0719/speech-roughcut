'use strict';

const FORMAT = 'speech-roughcut-learning-diff';
const FORMAT_VERSION = 1;
const CONTEXT_RADIUS = 6;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function normalizeWordIds(value, label, knownWordIds) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 word ID 数组`);
  const result = new Set();
  for (const rawId of value) {
    const id = requireString(rawId, `${label} 项`);
    if (!knownWordIds.has(id)) throw new Error(`${label} 引用未知 word: ${id}`);
    result.add(id);
  }
  return result;
}

function validateWords(words) {
  if (!Array.isArray(words)) throw new Error('words 必须是数组');
  const seen = new Set();
  return words.map((word, index) => {
    if (!isPlainObject(word)) throw new Error(`words[${index}] 必须是对象`);
    const id = requireString(word.id, `words[${index}].id`);
    const text = requireString(word.text, `words[${index}].text`);
    if (seen.has(id)) throw new Error(`重复 word ID: ${id}`);
    seen.add(id);
    return { id, text };
  });
}

function contextFor(words, index) {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(words.length, index + CONTEXT_RADIUS + 1);
  return words.slice(start, end).map((word, relativeIndex) => {
    const absoluteIndex = start + relativeIndex;
    return absoluteIndex === index ? `【${word.text}】` : word.text;
  }).join('');
}

function buildLearningDiff({
  mediaName,
  words,
  initialSuggestedWordDeleteIds,
  finalDeletedWordIds,
}) {
  const normalizedWords = validateWords(words);
  const knownWordIds = new Set(normalizedWords.map(word => word.id));
  const initial = normalizeWordIds(
    initialSuggestedWordDeleteIds,
    'initialSuggestedWordDeleteIds',
    knownWordIds,
  );
  const final = normalizeWordIds(finalDeletedWordIds, 'finalDeletedWordIds', knownWordIds);
  const aiOnly = [];
  const userOnly = [];
  normalizedWords.forEach((word, index) => {
    const entry = {
      wordId: word.id,
      text: word.text,
      context: contextFor(normalizedWords, index),
    };
    if (initial.has(word.id) && !final.has(word.id)) aiOnly.push(entry);
    if (!initial.has(word.id) && final.has(word.id)) userOnly.push(entry);
  });
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    mediaName: requireString(mediaName, 'mediaName'),
    aiOnly,
    userOnly,
  };
}

function validateEntry(entry, label) {
  if (!isPlainObject(entry)) throw new Error(`${label} 必须是对象`);
  const keys = Object.keys(entry).sort();
  if (keys.join(',') !== 'context,text,wordId') {
    throw new Error(`${label} 不是当前格式的 word diff`);
  }
  return {
    wordId: requireString(entry.wordId, `${label}.wordId`),
    text: requireString(entry.text, `${label}.text`),
    context: requireString(entry.context, `${label}.context`),
  };
}

function validateLearningDiff(value) {
  if (!isPlainObject(value) || value.format !== FORMAT) {
    throw new Error('learning diff 不是当前格式');
  }
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new Error(`learning diff 版本不匹配: 需要 ${FORMAT_VERSION}`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'aiOnly,format,formatVersion,mediaName,userOnly') {
    throw new Error('learning diff 不是当前格式');
  }
  if (!Array.isArray(value.aiOnly) || !Array.isArray(value.userOnly)) {
    throw new Error('learning diff 不是当前格式');
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    mediaName: requireString(value.mediaName, 'mediaName'),
    aiOnly: value.aiOnly.map((entry, index) => validateEntry(entry, `aiOnly[${index}]`)),
    userOnly: value.userOnly.map((entry, index) => validateEntry(entry, `userOnly[${index}]`)),
  };
}

function parseLearningDiff(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw new Error('learning diff 不是有效 JSON');
  }
  return validateLearningDiff(value);
}

function serializeLearningDiff(value) {
  return `${JSON.stringify(validateLearningDiff(value), null, 2)}\n`;
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  buildLearningDiff,
  parseLearningDiff,
  serializeLearningDiff,
  validateLearningDiff,
};
