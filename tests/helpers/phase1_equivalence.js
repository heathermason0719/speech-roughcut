'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stableMediaContext(context) {
  const copy = structuredClone(context);
  // File identity and invocation directories necessarily differ between runs.
  // Preserve every media, sample, offset, duration and timebase field verbatim.
  for (const key of [
    'sourcePath', 'reviewAudioPath', 'playbackPath', 'exportPath',
    'sourceFingerprint', 'reviewFingerprint',
  ]) delete copy[key];
  return copy;
}

function stableXml(xml) {
  return xml
    .replace(/\b(src|location)="[^"]*"/g, '$1="<temporary-path>"')
    .replace(/\buid="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g,
      'uid="<generated-uuid>"');
}

function xmlTimeAttributes(xml) {
  const result = [];
  for (const element of xml.matchAll(/<([\w:-]+)\b([^>]*)>/g)) {
    const attributes = [...element[2].matchAll(/([\w:-]+)="([^"]*)"/g)]
      .filter(match => /^-?\d+(?:\/\d+|\.\d+)?s$/.test(match[2]))
      .map(match => [match[1], match[2]]);
    if (attributes.length) result.push([element[1], attributes]);
  }
  assert.ok(result.some(([tag]) => tag === 'asset-clip'), '必须实际序列化剪辑时间');
  return result;
}

async function captureSnapshot(checkoutRoot, source, outputRoot) {
  const load = relative => require(path.join(checkoutRoot, 'scripts', relative));
  const { prepareMedia } = load('prepare_media.js');
  const { generateReview } = load('generate_review.js');
  const { normalizeProviderWords, deriveAsrBreaks } = load('lib/transcript_model.js');
  const { compileEdit } = load('lib/compile_edit.js');
  const { createEditState, transitionEditState } = load('lib/edit_state.js');
  const { buildFcpxml } = load('lib/fcpxml.js');
  const constants = load('lib/time_contract.js');
  const transcribeDir = path.join(outputRoot, 'transcribe');
  const reviewDir = path.join(outputRoot, 'review');
  const context = await prepareMedia(source, transcribeDir);
  const words = normalizeProviderWords([
    { text: '开头', start_time: 101, end_time: 187 },
    { text: '删除', start_time: 1401, end_time: 1487 },
    { text: '结尾', start_time: 2801, end_time: 2887 },
  ], {
    reviewSampleRate: context.review.sampleRate,
    asrPresentationOffset: context.offsets.asrPresentationOffset,
  });
  const asrBreaks = deriveAsrBreaks(words);
  const wordsFile = path.join(outputRoot, 'words.json');
  const asrBreaksFile = path.join(outputRoot, 'asr_breaks.json');
  const autoSelectedFile = path.join(outputRoot, 'selected.json');
  fs.writeFileSync(wordsFile, JSON.stringify(words));
  fs.writeFileSync(asrBreaksFile, JSON.stringify(asrBreaks));
  fs.writeFileSync(autoSelectedFile, JSON.stringify({ wordIds: [words[1].id] }));
  const { data, analysis } = await generateReview({
    wordsFile, asrBreaksFile, autoSelectedFile,
    contextFile: path.join(transcribeDir, 'media_context.json'),
    outDir: reviewDir,
  });
  const detectedSilence = analysis.detectedSilence.filter(item => item.thresholdDb === -35);
  assert.ok(detectedSilence.length >= 2, '合成输入必须包含独立的 PCM 静音证据');
  const initial = createEditState({ initialSuggestedWordDeletes: data.initialSuggestedWordDeletes });
  const scenarios = {
    wordDeletion: createEditState({
      ...initial,
      policy: { autoSilenceEnabled: false, silencePaddingStartSamples: 137, silencePaddingEndSamples: 211 },
    }),
    pcmSilence: initial,
    restoredWord: transitionEditState(initial, { type: 'RESTORE_WORD', wordId: words[1].id }),
    manualRange: createEditState({
      policy: { autoSilenceEnabled: false },
      manualDeleteRanges: [{ startSample: 24001, endSample: 57607 }],
    }),
  };
  const outputs = {};
  for (const [name, editState] of Object.entries(scenarios)) {
    const compiledCutPlan = compileEdit({ words, asrBreaks, detectedSilence, editState, mediaContext: context });
    assert.ok(compiledCutPlan.cuts.length > 0, `${name} 必须产生实际 cut`);
    assert.ok(compiledCutPlan.keeps.length >= 2, `${name} 必须覆盖多个 keep`);
    assert.ok(compiledCutPlan.titleBlocks.length > 0, `${name} 必须覆盖标题时间`);
    const exports = {};
    for (const includeTitles of [false, true]) {
      const { xml } = buildFcpxml({
        mediaContext: context, compiledCutPlan, includeTitles, outputDirectory: outputRoot,
      });
      exports[includeTitles ? 'withTitles' : 'withoutTitles'] = {
        timeAttributes: xmlTimeAttributes(xml),
        xml: stableXml(xml),
      };
    }
    outputs[name] = { editState, compiledCutPlan, exports };
  }
  return {
    constants,
    data: { ...data, mediaContext: stableMediaContext(context) },
    analysis,
    scenarios: outputs,
  };
}

module.exports = { captureSnapshot };
