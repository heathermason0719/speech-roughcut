(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./title_plan'));
  else root.CompileEdit = factory(root.TitlePlan);
})(typeof self !== 'undefined' ? self : this, function (TitlePlan) {
  'use strict';

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function normalizeIntervals(intervals, durationSamples, mergeGapSamples = 0) {
    const sorted = (intervals || []).map(interval => ({
      startSample: clamp(Math.round(interval.startSample), 0, durationSamples),
      endSample: clamp(Math.round(interval.endSample), 0, durationSamples),
    })).filter(interval => interval.endSample > interval.startSample)
      .sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);
    const merged = [];
    for (const interval of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || interval.startSample > previous.endSample + mergeGapSamples) {
        merged.push({ ...interval });
      } else {
        previous.endSample = Math.max(previous.endSample, interval.endSample);
      }
    }
    return merged;
  }

  function subtractIntervals(intervals, protectedIntervals) {
    let output = intervals.map(interval => ({ ...interval }));
    for (const protectedInterval of protectedIntervals) {
      const next = [];
      for (const interval of output) {
        if (protectedInterval.endSample <= interval.startSample
            || protectedInterval.startSample >= interval.endSample) {
          next.push(interval);
          continue;
        }
        if (protectedInterval.startSample > interval.startSample) {
          next.push({ startSample: interval.startSample, endSample: protectedInterval.startSample });
        }
        if (protectedInterval.endSample < interval.endSample) {
          next.push({ startSample: protectedInterval.endSample, endSample: interval.endSample });
        }
      }
      output = next;
    }
    return output;
  }

  function complement(intervals, start, end) {
    const output = [];
    let cursor = start;
    for (const interval of intervals) {
      if (interval.startSample > cursor) {
        output.push({ startSample: cursor, endSample: interval.startSample });
      }
      cursor = Math.max(cursor, interval.endSample);
    }
    if (cursor < end) output.push({ startSample: cursor, endSample: end });
    return output;
  }

  function overlaps(left, right) {
    return left.startSample < right.endSample && left.endSample > right.startSample;
  }

  function buildDeletedWordRuns(
    words,
    deletedWordIds,
    durationSamples,
    paddingStartSamples,
    paddingEndSamples,
  ) {
    const runs = [];
    let current = null;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (!deletedWordIds.has(word.id)) {
        if (current) {
          current.endSample = Math.min(
            durationSamples,
            Math.max(current.endSample, word.startSample - paddingStartSamples),
          );
        }
        current = null;
        continue;
      }
      if (!current) {
        const previous = words[index - 1];
        current = {
          startSample: previous
            ? Math.max(0, Math.min(word.startSample, previous.endSample + paddingEndSamples))
            : 0,
          endSample: word.endSample,
        };
        runs.push(current);
      } else {
        current.endSample = Math.max(current.endSample, word.endSample);
      }
    }
    if (current) current.endSample = durationSamples;
    return runs;
  }

  function validateTimebase(timebase) {
    if (!timebase || !['audio-samples', 'video-frames'].includes(timebase.kind)) {
      throw new Error('timebase 无效');
    }
    if (timebase.kind === 'audio-samples' && !(Number.isInteger(timebase.ticksPerSecond) && timebase.ticksPerSecond > 0)) {
      throw new Error('audio timebase 无效');
    }
    if (timebase.kind === 'video-frames'
        && (!(Number.isInteger(timebase.fpsNum) && timebase.fpsNum > 0)
          || !(Number.isInteger(timebase.fpsDen) && timebase.fpsDen > 0))) {
      throw new Error('video timebase 无效');
    }
  }

  function makeGrid(timebase, reviewSampleRate, sourceOffsetSeconds) {
    const ticksPerSecond = timebase.kind === 'audio-samples'
      ? timebase.ticksPerSecond
      : timebase.fpsNum / timebase.fpsDen;
    const reviewToFloatTick = sample => (
      (sample / reviewSampleRate + sourceOffsetSeconds) * ticksPerSecond
    );
    const sourceTickToReviewSample = tick => Math.round(
      (tick / ticksPerSecond - sourceOffsetSeconds) * reviewSampleRate,
    );
    return {
      startTick: sample => Math.floor(reviewToFloatTick(sample) + 1e-9),
      endTick: sample => Math.ceil(reviewToFloatTick(sample) - 1e-9),
      sourceTickToReviewSample,
    };
  }

  function assertWord(word, durationSamples) {
    if (!word || !word.id || !Number.isInteger(word.startSample) || !Number.isInteger(word.endSample)
        || word.startSample < 0 || word.endSample <= word.startSample || word.endSample > durationSamples) {
      throw new Error(`word 时间合同无效: ${word && word.id ? word.id : '(unknown)'}`);
    }
  }

  function validateCompiledCutPlan(plan) {
    validateTimebase(plan.timebase);
    if (!Number.isInteger(plan.sourceOriginTick)
        || !Number.isInteger(plan.sourceDurationTicks)
        || plan.sourceDurationTicks <= plan.sourceOriginTick) {
      throw new Error('compiledCutPlan source range 无效');
    }
    let sourceCursor = plan.sourceOriginTick;
    let outputCursor = 0;
    for (const keep of plan.keeps) {
      for (const field of ['sourceStartTick', 'sourceEndTick', 'outputStartTick', 'outputEndTick', 'reviewStartSample', 'reviewEndSample']) {
        if (!Number.isInteger(keep[field])) throw new Error(`compiledCutPlan keep ${field} 必须为整数`);
      }
      if (keep.sourceStartTick < sourceCursor || keep.sourceEndTick <= keep.sourceStartTick) {
        throw new Error('compiledCutPlan keeps 必须有序且不重叠');
      }
      if (keep.outputStartTick !== outputCursor
          || keep.outputEndTick - keep.outputStartTick !== keep.sourceEndTick - keep.sourceStartTick) {
        throw new Error('compiledCutPlan output ticks 必须从 0 连续累加');
      }
      sourceCursor = keep.sourceEndTick;
      outputCursor = keep.outputEndTick;
    }
    const coverage = [
      ...plan.keeps.map(keep => ({ start: keep.sourceStartTick, end: keep.sourceEndTick })),
      ...plan.cuts.map(cut => ({ start: cut.sourceStartTick, end: cut.sourceEndTick })),
    ].sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = plan.sourceOriginTick;
    for (const interval of coverage) {
      if (!Number.isInteger(interval.start) || !Number.isInteger(interval.end)
          || interval.start !== cursor || interval.end <= interval.start) {
        throw new Error('compiledCutPlan keeps/cuts 必须严格互补');
      }
      cursor = interval.end;
    }
    if (cursor !== plan.sourceDurationTicks) throw new Error('compiledCutPlan 未覆盖完整 source range');
    for (const title of plan.titleBlocks) {
      const keep = plan.keeps[title.keepIndex];
      if (!keep || !Number.isInteger(title.outputStartTick) || !Number.isInteger(title.outputEndTick)
          || !Number.isInteger(title.reviewStartSample) || !Number.isInteger(title.reviewEndSample)
          || title.outputStartTick < keep.outputStartTick
          || title.outputEndTick > keep.outputEndTick
          || title.outputEndTick <= title.outputStartTick
          || title.reviewStartSample < keep.reviewStartSample
          || title.reviewEndSample > keep.reviewEndSample
          || title.reviewEndSample <= title.reviewStartSample) {
        throw new Error('title block 超出所属 keep');
      }
    }
    return plan;
  }

  function compileEdit({ words = [], asrBreaks = [], detectedSilence = [], editState, mediaContext }) {
    if (!editState || !mediaContext || !mediaContext.review) throw new Error('compileEdit 缺少输入');
    const reviewSampleRate = Number(mediaContext.review.sampleRate);
    const durationSamples = Number(mediaContext.review.decodedSampleCount);
    if (!(Number.isInteger(reviewSampleRate) && reviewSampleRate > 0)
        || !(Number.isInteger(durationSamples) && durationSamples > 0)) {
      throw new Error('review sample clock 无效');
    }
    validateTimebase(mediaContext.timebase);
    const sourceOffset = mediaContext.offsets && mediaContext.offsets.sourceMediaOffset;
    if (!sourceOffset || sourceOffset.status !== 'verified' || !Number.isFinite(sourceOffset.seconds)) {
      throw new Error('sourceMediaOffset 未验证');
    }
    const wordById = new Map();
    for (const word of words) {
      assertWord(word, durationSamples);
      if (wordById.has(word.id)) throw new Error(`重复 word id: ${word.id}`);
      wordById.set(word.id, word);
    }
    const policy = editState.policy || {};
    const paddingStartSamples = Math.max(0, Number(policy.silencePaddingStartSamples || 0));
    const paddingEndSamples = Math.max(0, Number(policy.silencePaddingEndSamples || 0));
    const currentDeleted = new Set(editState.currentDeletedWordIds || []);
    const restoredWordIds = new Set(editState.explicitlyRestoredWordIds || []);
    const protectedWords = [...restoredWordIds].map(id => wordById.get(id)).filter(Boolean)
      .map(word => ({ startSample: word.startSample, endSample: word.endSample }));
    const protectedSilenceRanges = normalizeIntervals(
      editState.explicitlyRestoredSilenceRanges || [],
      durationSamples,
    );
    for (const id of currentDeleted) {
      if (!wordById.has(id)) throw new Error(`editState 引用未知 word: ${id}`);
    }
    const wordDeletes = buildDeletedWordRuns(
      words,
      currentDeleted,
      durationSamples,
      paddingStartSamples,
      paddingEndSamples,
    );
    const manualDeletes = (editState.manualDeleteRanges || []).map(range => ({ ...range }));
    const silenceDeletes = [];
    if (policy.autoSilenceEnabled !== false) {
      for (const silence of detectedSilence) {
        if (!Number.isInteger(silence.startSample) || !Number.isInteger(silence.endSample)
            || silence.endSample <= silence.startSample || !silence.energy
            || !Number.isFinite(silence.energy.maxDb)) {
          throw new Error(`detectedSilence 缺少 PCM 证据: ${silence.id || '(unknown)'}`);
        }
        if (silence.endSample - silence.startSample < Number(policy.minimumSilenceSamples || 0)) continue;
        if (silence.energy.maxDb > Number(policy.silenceThresholdDb)) continue;
        const startSample = silence.startSample + paddingStartSamples;
        const endSample = silence.endSample - paddingEndSamples;
        if (endSample > startSample) silenceDeletes.push({ startSample, endSample });
      }
    }
    const effectiveSilenceDeletes = subtractIntervals(silenceDeletes, protectedSilenceRanges);
    let cuts = normalizeIntervals(
      [...wordDeletes, ...manualDeletes, ...effectiveSilenceDeletes],
      durationSamples,
      Number(policy.mergeGapSamples || 0),
    );
    cuts = subtractIntervals(cuts, protectedWords);
    let semanticKeeps = complement(cuts, 0, durationSamples);
    const minimumKeepSamples = Number(policy.minimumKeepSamples || 0);
    if (minimumKeepSamples > 1) {
      const disposable = semanticKeeps.filter(keep => keep.endSample - keep.startSample < minimumKeepSamples
        && !protectedWords.some(protectedInterval => overlaps(keep, protectedInterval)));
      if (disposable.length) {
        cuts = normalizeIntervals([...cuts, ...disposable], durationSamples, Number(policy.mergeGapSamples || 0));
        cuts = subtractIntervals(cuts, protectedWords);
        semanticKeeps = complement(cuts, 0, durationSamples);
      }
    }

    const grid = makeGrid(mediaContext.timebase, reviewSampleRate, sourceOffset.seconds);
    const sourceOriginTick = grid.startTick(0);
    const sourceDurationTicks = grid.endTick(durationSamples);
    const quantized = semanticKeeps.map(keep => ({
      sourceStartTick: clamp(grid.startTick(keep.startSample), sourceOriginTick, sourceDurationTicks),
      sourceEndTick: clamp(grid.endTick(keep.endSample), sourceOriginTick, sourceDurationTicks),
    })).filter(keep => keep.sourceEndTick > keep.sourceStartTick)
      .sort((left, right) => left.sourceStartTick - right.sourceStartTick);
    const merged = [];
    for (const keep of quantized) {
      const previous = merged[merged.length - 1];
      if (!previous || keep.sourceStartTick > previous.sourceEndTick) merged.push({ ...keep });
      else previous.sourceEndTick = Math.max(previous.sourceEndTick, keep.sourceEndTick);
    }
    let outputTick = 0;
    const keeps = merged.map((keep, index) => {
      const durationTicks = keep.sourceEndTick - keep.sourceStartTick;
      const item = {
        id: `keep-${String(index).padStart(4, '0')}`,
        sourceStartTick: keep.sourceStartTick,
        sourceEndTick: keep.sourceEndTick,
        outputStartTick: outputTick,
        outputEndTick: outputTick + durationTicks,
        reviewStartSample: clamp(grid.sourceTickToReviewSample(keep.sourceStartTick), 0, durationSamples),
        reviewEndSample: clamp(grid.sourceTickToReviewSample(keep.sourceEndTick), 0, durationSamples),
      };
      outputTick += durationTicks;
      return item;
    });
    const sourceCutRanges = [];
    let sourceCursor = sourceOriginTick;
    for (const keep of keeps) {
      if (keep.sourceStartTick > sourceCursor) {
        sourceCutRanges.push({ sourceStartTick: sourceCursor, sourceEndTick: keep.sourceStartTick });
      }
      sourceCursor = keep.sourceEndTick;
    }
    if (sourceCursor < sourceDurationTicks) {
      sourceCutRanges.push({ sourceStartTick: sourceCursor, sourceEndTick: sourceDurationTicks });
    }
    const sourceCuts = sourceCutRanges.map((cut, index) => ({
      id: `cut-${String(index).padStart(4, '0')}`,
      ...cut,
      reviewStartSample: clamp(grid.sourceTickToReviewSample(cut.sourceStartTick), 0, durationSamples),
      reviewEndSample: clamp(grid.sourceTickToReviewSample(cut.sourceEndTick), 0, durationSamples),
    }));

    const wordTickRanges = {};
    for (const word of words) {
      wordTickRanges[word.id] = {
        sourceStartTick: clamp(grid.startTick(word.startSample), sourceOriginTick, sourceDurationTicks),
        sourceEndTick: clamp(grid.endTick(word.endSample), sourceOriginTick, sourceDurationTicks),
      };
    }
    const retainedWordIds = words.filter(word => {
      if (currentDeleted.has(word.id)) return false;
      const range = wordTickRanges[word.id];
      return keeps.some(keep => range.sourceStartTick < keep.sourceEndTick
        && range.sourceEndTick > keep.sourceStartTick);
    }).map(word => word.id);
    const titleBlocks = TitlePlan.planTitleBlocks({
      words,
      retainedWordIds,
      asrBreaks,
      keeps,
      wordTickRanges,
      reviewSampleRate,
      maxVisualWidth: Number(policy.titleMaxVisualWidth || 14),
    });
    const plan = {
      timebase: { ...mediaContext.timebase },
      reviewSampleRate,
      reviewDecodedSampleCount: durationSamples,
      sourceOriginTick,
      sourceDurationTicks,
      keeps,
      cuts: sourceCuts,
      retainedWordIds,
      titleBlocks,
      wordDecisions: {
        initialSuggestedWordDeleteIds: [...new Set(editState.initialSuggestedWordDeletes || [])].sort(),
        finalDeletedWordIds: [...currentDeleted].sort(),
      },
    };
    return validateCompiledCutPlan(plan);
  }

  return {
    compileEdit,
    validateCompiledCutPlan,
  };
});
