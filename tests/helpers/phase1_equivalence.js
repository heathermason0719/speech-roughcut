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

// Compare the frozen semantic snapshots unchanged. For audio exports only,
// validate the FCP-proven carrier contract, then compare the unchanged XML
// payload after projecting both layouts into the same source/output clocks.
function assertSnapshotTimeEquivalent(current, baseline) {
  const normalized = structuredClone(current);
  const expected = structuredClone(baseline);
  if (current.data.mediaContext.timebase.kind === 'audio-samples') {
    const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const fraction = text => text.slice(0, -1).split('/').map(BigInt);
    const ticks = (text, rate) => {
      const [n, d = 1n] = fraction(text);
      assert.equal(n * BigInt(rate) % d, 0n, `not exact ticks: ${text}`);
      return n * BigInt(rate) / d;
    };
    const compact = xml => xml.replace(/>\s+</g, '><').trim();
    for (const [name, scenario] of Object.entries(current.scenarios)) {
      const plan = scenario.compiledCutPlan, rate = plan.timebase.ticksPerSecond;
      const total = BigInt(plan.keeps.at(-1)?.outputEndTick || 0);
      const frameCount = (total * 30n + BigInt(rate) - 1n) / BigInt(rate);
      for (const key of ['withoutTitles', 'withTitles']) {
        function project(output, connected) {
          const xml = output.xml;
          const sequence = attrs(xml.match(/<sequence\b([^>]*)>/)[1]);
          const gap = xml.match(/<gap\b([^>]*)>([\s\S]*?)<\/gap>/);
          let origin = 0n;
          if (connected) {
            assert.ok(gap, 'audio requires a single Primary Storyline carrier');
            assert.equal((xml.match(/<gap /g) || []).length, 1);
            const ga = attrs(gap[1]);
            assert.equal(ga.start, '3600s');
            assert.equal(ticks(ga.offset, rate), 0n);
            assert.equal(ticks(ga.duration, 30), frameCount);
            assert.equal(ticks(sequence.duration, 30), frameCount);
            origin = 3600n * BigInt(rate);
            assert.doesNotMatch(gap[2], /<\/asset-clip>/, 'Titles must be siblings of audio');
          } else {
            assert.equal(gap, null);
            assert.equal(ticks(sequence.duration, rate), total);
          }
          const clips = [...xml.matchAll(/<asset-clip\b([^>]*)>/g)].map(m => attrs(m[1]));
          assert.equal(clips.length, plan.keeps.length);
          clips.forEach((c, i) => {
            const k = plan.keeps[i];
            assert.equal(ticks(c.start, rate), BigInt(k.sourceStartTick));
            assert.equal(ticks(c.duration, rate), BigInt(k.sourceEndTick - k.sourceStartTick));
            assert.equal(ticks(c.offset, rate) - origin, BigInt(k.outputStartTick));
            if (connected) { assert.equal(c.lane, '-1'); delete c.lane; }
            c.offset = `${k.outputStartTick}/${rate}s`;
          });
          const blocks = [...xml.matchAll(/<title\b([^>]*)>[\s\S]*?<\/title>/g)];
          assert.equal(blocks.length, key === 'withTitles' ? plan.titleBlocks.length : 0);
          const titles = blocks.map((m, i) => {
            const a = attrs(m[1]), block = plan.titleBlocks[i], keep = plan.keeps[block.keepIndex];
            if (connected) {
              const first = ticks(a.offset, 30) - 108000n;
              const duration = ticks(a.duration, 30);
              assert.ok(duration > 0n);
              const last = first + duration;
              assert.ok(first * BigInt(rate) >= BigInt(keep.outputStartTick) * 30n);
              assert.ok(last * BigInt(rate) <= BigInt(keep.outputEndTick) * 30n);
              for (const [frame, tick] of [[first, block.outputStartTick], [last, block.outputEndTick]]) {
                const delta = frame * BigInt(rate) - BigInt(tick) * 30n;
                assert.ok((delta < 0n ? -delta : delta) < BigInt(rate));
              }
            } else {
              assert.equal(ticks(a.offset, rate), BigInt(keep.sourceStartTick + block.outputStartTick - keep.outputStartTick));
              assert.equal(ticks(a.duration, rate), BigInt(block.outputEndTick - block.outputStartTick));
            }
            return compact(m[0].replace(/^<title\b[^>]*>/, tag =>
              tag.replace(/\b(offset|duration)="[^"]*"/g, '$1="<accepted-title-grid>"')));
          });
          // All resources, media metadata, sequence attributes other than the
          // accepted carrier duration, and every Title payload remain equal.
          const skeleton = compact(xml.replace(/<spine>[\s\S]*?<\/spine>/, '<spine/>')
            .replace(/<sequence\b[^>]*>/, tag => tag.replace(/duration="[^"]*"/, 'duration="<accepted-carrier>"')));
          return { skeleton, clips, titles };
        }
        normalized.scenarios[name].exports[key] = project(scenario.exports[key], true);
        expected.scenarios[name].exports[key] = project(baseline.scenarios[name].exports[key], false);
      }
    }
  }
  assert.deepEqual(normalized, expected);
}

module.exports = { captureSnapshot, assertSnapshotTimeEquivalent };
