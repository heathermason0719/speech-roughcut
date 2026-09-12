(function (root, factory) {
  root.ReviewWorkbench = factory(
    root,
    root.EditState,
    root.CompileEdit,
    root.SubtitleBlocks,
  );
})(typeof self !== 'undefined' ? self : this, function (
  root,
  EditState,
  CompileEdit,
  SubtitleBlocks,
) {
  'use strict';

  const WAVE_THEMES = {
    cool: {
      bg: '#0E0E13', wave: '#8CA0C8', silence: 'rgba(44,46,54,0.9)',
      del: 'rgba(248,113,113,0.46)', delEdge: 'rgba(248,113,113,0.95)',
      cut: 'rgba(255,193,7,0.36)', cutEdge: 'rgba(255,193,7,0.98)', head: '#FF7A4D',
    },
    mint: {
      bg: '#0D0F0E', wave: '#5EEAD4', silence: 'rgba(40,48,46,0.9)',
      del: 'rgba(251,113,133,0.40)', delEdge: 'rgba(251,113,133,0.95)',
      cut: 'rgba(251,146,60,0.42)', cutEdge: 'rgba(251,146,60,0.98)', head: '#FB7185',
    },
    recut: {
      bg: '#1A1917', wave: '#A89F90', silence: 'rgba(52,50,46,0.92)',
      del: 'rgba(248,113,113,0.42)', delEdge: 'rgba(248,113,113,0.92)',
      cut: 'rgba(251,191,36,0.42)', cutEdge: 'rgba(251,191,36,0.96)', head: '#FF7A4D',
    },
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mount() {
    const api = {
      ready: false,
      error: null,
    };
    root.__reviewTest = api;

    const player = document.getElementById('player');
    const content = document.getElementById('content');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingLabel = document.getElementById('loadingLabel');
    const loadingTime = document.getElementById('loadingTime');
    const exportButton = document.getElementById('exportButton');
    const includeTitles = document.getElementById('includeTitles');
    const timeCurrent = document.getElementById('timeCur');
    const timeTotal = document.getElementById('timeTot');
    const canvas = document.getElementById('waveCanvas');
    const playheadCanvas = document.getElementById('wavePlayheadCanvas');
    const rulerCanvas = document.getElementById('rulerCanvas');
    const titlePreview = document.getElementById('titlePreview');

    let words = [];
    let asrBreaks = [];
    let allDetectedSilence = [];
    let detectedSilence = [];
    let peaksData = null;
    let mediaContext = null;
    let mediaCapabilityReady = false;
    let mediaFailure = null;
    let editState = null;
    let compiledCutPlan = null;
    let planRevision = 0;
    let lastExportPayload = null;
    let undoStack = [];
    let previewRange = null;
    let latchedCutId = null;
    let pendingSeek = null;
    let seekWrites = {};
    let rafId = 0;
    let currentWordElement = null;
    let waveScale = 1;
    let waveStartSample = 0;
    let suppressWaveClick = false;
    let waveBackgroundKey = '';
    const waveRenderStats = { backgroundRenders: 0, playheadRenders: 0 };
    const consumerPlans = {
      wave: null,
      playback: null,
      text: null,
      title: null,
      export: null,
    };

    const sampleRate = () => Number(mediaContext.review.sampleRate);
    const durationSamples = () => Number(mediaContext.review.decodedSampleCount);
    const playerOffsetSeconds = () => Number(
      mediaContext.offsets.playerPresentationOffset.seconds,
    );
    const reviewSampleToPlayerSeconds = sample => sample / sampleRate() + playerOffsetSeconds();
    const playerSecondsToReviewSample = seconds => Math.round(
      (seconds - playerOffsetSeconds()) * sampleRate(),
    );
    const formatSeconds = value => {
      const seconds = Math.max(0, Number(value) || 0);
      const minutes = Math.floor(seconds / 60);
      const remainder = Math.floor(seconds % 60);
      return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    };
    const formatSample = sample => formatSeconds(sample / sampleRate());

    function setReviewInteractionEnabled(enabled) {
      for (const node of document.querySelectorAll('.topbar, .workspace')) {
        node.inert = !enabled;
      }
    }

    function failClosed(error) {
      api.error = error instanceof Error ? error.message : String(error);
      api.ready = false;
      setReviewInteractionEnabled(false);
      exportButton.disabled = true;
      exportButton.title = api.error;
      loadingOverlay.classList.add('show');
      loadingLabel.textContent = '审核合同校验失败';
      loadingTime.textContent = api.error;
    }

    function failMedia(error) {
      mediaFailure = error instanceof Error ? error.message : String(error);
      mediaCapabilityReady = false;
      player.pause();
      failClosed(mediaFailure);
    }

    function ticksPerSecond(timebase) {
      return timebase.kind === 'audio-samples'
        ? timebase.ticksPerSecond
        : timebase.fpsNum / timebase.fpsDen;
    }

    function currentOutputSeconds() {
      if (!compiledCutPlan || !compiledCutPlan.keeps.length) return 0;
      const last = compiledCutPlan.keeps[compiledCutPlan.keeps.length - 1];
      return last.outputEndTick / ticksPerSecond(compiledCutPlan.timebase);
    }

    function setConsumerPlan(plan) {
      consumerPlans.wave = plan;
      consumerPlans.playback = plan;
      consumerPlans.text = plan;
      consumerPlans.title = plan;
      consumerPlans.export = plan;
      canvas.dataset.planRevision = String(planRevision);
      content.dataset.planRevision = String(planRevision);
      exportButton.dataset.planRevision = String(planRevision);
    }

    function updateTitlePreview(reviewSample) {
      if (!titlePreview || !compiledCutPlan) return;
      const block = includeTitles.checked
        ? compiledCutPlan.titleBlocks.find(item => (
          reviewSample >= item.reviewStartSample && reviewSample < item.reviewEndSample
        ))
        : null;
      titlePreview.textContent = block ? block.text : '';
      titlePreview.classList.toggle('visible', Boolean(block));
      titlePreview.dataset.titleId = block ? block.id : '';
      titlePreview.dataset.outputStartTick = block ? String(block.outputStartTick) : '';
      titlePreview.dataset.outputEndTick = block ? String(block.outputEndTick) : '';
    }

    function refreshPlan() {
      try {
        if (!mediaCapabilityReady) throw new Error(mediaFailure || '浏览器媒体能力尚未验证');
        if (editState) detectedSilence = candidatesForThreshold(editState.policy.silenceThresholdDb);
        compiledCutPlan = CompileEdit.compileEdit({
          words,
          asrBreaks,
          detectedSilence,
          editState,
          mediaContext,
        });
        planRevision += 1;
        setConsumerPlan(compiledCutPlan);
        api.error = null;
        exportButton.disabled = false;
        exportButton.title = '';
        refreshSelectionStyles();
        drawWave();
        document.getElementById('tl-total').textContent = formatSample(durationSamples());
        document.getElementById('tl-final').textContent = formatSeconds(currentOutputSeconds());
        updateTitlePreview(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
        return compiledCutPlan;
      } catch (error) {
        failClosed(error);
        return null;
      }
    }

    function pushUndo() {
      undoStack.push(clone(editState));
      if (undoStack.length > 100) undoStack.shift();
    }

    function dispatch(action, record = true) {
      if (record) pushUndo();
      const previousThreshold = Number(editState.policy.silenceThresholdDb);
      try {
        editState = EditState.transitionEditState(editState, action);
      } catch (error) {
        failClosed(error);
        throw error;
      }
      const thresholdChanged = Number(editState.policy.silenceThresholdDb) !== previousThreshold;
      if (thresholdChanged) {
        syncDetectedSilence();
        renderTranscript();
      }
      return refreshPlan();
    }

    function undo() {
      if (!undoStack.length) return compiledCutPlan;
      editState = undoStack.pop();
      syncDetectedSilence();
      renderTranscript();
      return refreshPlan();
    }

    function cutAtSample(sample) {
      if (!compiledCutPlan) return null;
      let low = 0;
      let high = compiledCutPlan.cuts.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const cut = compiledCutPlan.cuts[middle];
        if (sample < cut.reviewStartSample) high = middle - 1;
        else if (sample >= cut.reviewEndSample) low = middle + 1;
        else return cut;
      }
      return null;
    }

    function processPlaybackSample(sample, performSeek = true) {
      if (previewRange) return null;
      if (pendingSeek) return null;
      const cut = cutAtSample(sample);
      if (!cut) {
        latchedCutId = null;
        return null;
      }
      if (latchedCutId === cut.id) return null;
      latchedCutId = cut.id;
      pendingSeek = { cutId: cut.id, targetSample: cut.reviewEndSample };
      seekWrites[cut.id] = (seekWrites[cut.id] || 0) + 1;
      if (performSeek) player.currentTime = reviewSampleToPlayerSeconds(cut.reviewEndSample);
      return cut.reviewEndSample;
    }

    function acknowledgePendingSeek() {
      const completed = pendingSeek;
      pendingSeek = null;
      return completed;
    }

    function beginPreview(range, play = false) {
      previewRange = {
        startSample: Math.max(0, Math.round(range.startSample)),
        endSample: Math.min(durationSamples(), Math.round(range.endSample)),
      };
      latchedCutId = null;
      pendingSeek = null;
      player.currentTime = reviewSampleToPlayerSeconds(previewRange.startSample);
      if (play) player.play().catch(failMedia);
    }

    function endPreview() {
      previewRange = null;
      latchedCutId = null;
      pendingSeek = null;
    }

    function seekReviewSample(sample) {
      endPreview();
      const bounded = Math.max(0, Math.min(durationSamples(), Math.round(sample)));
      player.currentTime = reviewSampleToPlayerSeconds(bounded);
      updatePlayhead(bounded);
    }

    function isReviewSampleAudible(sample) {
      return !cutAtSample(sample);
    }

    function gapRange(node) {
      const startSample = Number(node.dataset.startSample);
      const endSample = Number(node.dataset.endSample);
      if (!Number.isInteger(startSample)
        || !Number.isInteger(endSample)
        || endSample <= startSample) {
        throw new Error('空隙缺少有效整数 sample 边界');
      }
      return { startSample, endSample };
    }

    function gapCutCoverage(range) {
      if (!compiledCutPlan) return 'none';
      let deletedSamples = 0;
      for (const cut of compiledCutPlan.cuts) {
        deletedSamples += Math.max(
          0,
          Math.min(range.endSample, cut.reviewEndSample)
            - Math.max(range.startSample, cut.reviewStartSample),
        );
      }
      const duration = range.endSample - range.startSample;
      if (deletedSamples <= 0) return 'none';
      if (deletedSamples >= duration) return 'full';
      return 'partial';
    }

    function ensurePlanGapStyles() {
      if (document.getElementById('plan-gap-styles')) return;
      const style = document.createElement('style');
      style.id = 'plan-gap-styles';
      style.textContent = `
        .gap.plan-selected:not(.selected) {
          color: var(--paper-500);
          border-color: var(--ember);
          border-style: solid;
          background: var(--ember-wash);
          text-decoration: line-through;
          text-decoration-color: var(--danger);
          text-decoration-thickness: 2px;
        }
        .gap.plan-selected:not(.selected)::before,
        .gap.partial-selected:not(.selected)::before {
          background: var(--ember);
        }
        .gap.partial-selected:not(.selected) {
          color: var(--paper-400);
          border-color: rgba(255, 122, 77, .7);
          border-style: dashed;
        }
      `;
      document.head.appendChild(style);
    }

    function hasManualDeleteRange(range) {
      return editState.manualDeleteRanges.some(item => (
        item.startSample === range.startSample && item.endSample === range.endSample
      ));
    }

    function toggleManualDeleteRange(node) {
      const range = gapRange(node);
      return dispatch({
        type: hasManualDeleteRange(range)
          ? 'REMOVE_MANUAL_DELETE_RANGE'
          : 'ADD_MANUAL_DELETE_RANGE',
        range,
      });
    }

    function renderAsrBreak(item, parent) {
      const chip = document.createElement('span');
      chip.className = 'gap asr-break';
      chip.dataset.asrBreakId = item.id;
      chip.dataset.startSample = item.startSample;
      chip.dataset.endSample = item.endSample;
      chip.textContent = `ASR ${((item.endSample - item.startSample) / sampleRate()).toFixed(1)}s`;
      chip.dataset.baseTitle = 'ASR 分行先验；单击手动删除/恢复此空隙';
      chip.title = chip.dataset.baseTitle;
      parent.appendChild(chip);
    }

    function renderDetectedSilence(item, parent) {
      const chip = document.createElement('span');
      chip.className = 'gap detected-silence';
      chip.dataset.silenceId = item.id;
      chip.dataset.startSample = item.startSample;
      chip.dataset.endSample = item.endSample;
      chip.textContent = `PCM ${((item.endSample - item.startSample) / sampleRate()).toFixed(1)}s`;
      chip.dataset.baseTitle = `PCM 能量证据 max ${item.energy.maxDb} dB；单击手动删除/恢复此空隙`;
      chip.title = chip.dataset.baseTitle;
      parent.appendChild(chip);
    }

    function renderTranscript() {
      ensurePlanGapStyles();
      content.replaceChildren();
      const paragraphs = SubtitleBlocks.buildParagraphs({
        words,
        asrBreaks,
        reviewSampleRate: sampleRate(),
      });
      const breakAfterWord = new Map(asrBreaks.map(item => [item.previousWordId, item]));
      const silenceAfterWord = new Map();
      const leadingSilence = [];
      for (const silence of detectedSilence) {
        let previous = null;
        for (const word of words) {
          if (word.endSample <= silence.startSample) previous = word;
          else break;
        }
        if (!previous) leadingSilence.push(silence);
        else {
          if (!silenceAfterWord.has(previous.id)) silenceAfterWord.set(previous.id, []);
          silenceAfterWord.get(previous.id).push(silence);
        }
      }
      let renderedLeading = false;
      for (const paragraph of paragraphs) {
        const paragraphNode = document.createElement('div');
        paragraphNode.className = 'paragraph';
        const timecode = document.createElement('div');
        timecode.className = 'tc';
        timecode.innerHTML = `<span class="tc-bar"></span>${formatSample(paragraph.startSample)}`;
        const body = document.createElement('div');
        body.className = 'paragraph-body';
        if (!renderedLeading) {
          leadingSilence.forEach(item => renderDetectedSilence(item, body));
          renderedLeading = true;
        }
        for (const word of paragraph.words) {
          const wordNode = document.createElement('span');
          wordNode.className = 'word';
          wordNode.dataset.wordId = word.id;
          wordNode.dataset.startSample = word.startSample;
          wordNode.dataset.endSample = word.endSample;
          wordNode.textContent = word.text;
          body.appendChild(wordNode);
          const boundary = breakAfterWord.get(word.id);
          if (boundary) renderAsrBreak(boundary, body);
          for (const silence of silenceAfterWord.get(word.id) || []) {
            renderDetectedSilence(silence, body);
          }
        }
        paragraphNode.append(timecode, body);
        content.appendChild(paragraphNode);
      }
      refreshSelectionStyles();
    }

    function refreshSelectionStyles() {
      if (!editState) return;
      const deleted = new Set(editState.currentDeletedWordIds);
      const initial = new Set(editState.initialSuggestedWordDeletes);
      for (const node of content.querySelectorAll('[data-word-id]')) {
        const wordId = node.dataset.wordId;
        node.classList.toggle('selected', deleted.has(wordId));
        node.classList.toggle('ai-selected', initial.has(wordId));
      }
      for (const node of content.querySelectorAll('[data-asr-break-id], [data-silence-id]')) {
        const range = gapRange(node);
        const manuallyDeleted = hasManualDeleteRange(range);
        const coverage = gapCutCoverage(range);
        node.dataset.cutCoverage = coverage;
        node.classList.toggle('selected', manuallyDeleted);
        node.classList.toggle('plan-selected', !manuallyDeleted && coverage === 'full');
        node.classList.toggle('partial-selected', !manuallyDeleted && coverage === 'partial');
        node.classList.toggle('ai-selected', false);
        const status = coverage === 'full'
          ? '剪切计划：整段删除'
          : coverage === 'partial'
            ? '剪切计划：部分删除'
            : '剪切计划：保留';
        node.title = `${node.dataset.baseTitle || ''}；${status}`;
      }
    }

    function toggleSilence(silenceId) {
      const item = detectedSilence.find(candidate => String(candidate.id) === String(silenceId));
      if (!item) throw new Error(`未知 detectedSilence: ${silenceId}`);
      const range = { startSample: item.startSample, endSample: item.endSample };
      const restored = isSilenceRestored(item);
      if (restored) {
        const plan = dispatch({
          type: 'UNDO_RESTORE_SILENCE',
          silenceId,
          range,
        });
        // With automatic silence disabled there may be no underlying cut to
        // reinstate. Keep a second click useful, as one undoable user action.
        return gapCutCoverage(range) === 'none'
          ? dispatch({ type: 'ADD_MANUAL_DELETE_RANGE', range }, false)
          : plan;
      }
      if (gapCutCoverage(range) === 'none') {
        return dispatch({ type: 'ADD_MANUAL_DELETE_RANGE', range });
      }
      // Restore the effective cut, including overlapping automatic deletion.
      // Remove an exact manual mark so the chip does not remain struck out.
      pushUndo();
      editState = EditState.transitionEditState(editState, {
        type: 'REMOVE_MANUAL_DELETE_RANGE',
        range,
      });
      return dispatch({
        type: 'RESTORE_SILENCE',
        silenceId,
        range,
        wasEffective: true,
      }, false);
    }

    function candidatesForThreshold(value) {
      const threshold = Number(value);
      return allDetectedSilence.filter(item => Number(item.thresholdDb) === threshold);
    }

    function isSilenceRestored(item) {
      if (editState.explicitlyRestoredSilenceIds.includes(String(item.id))) return true;
      return editState.explicitlyRestoredSilenceRanges.some(range => (
        item.startSample < range.endSample && item.endSample > range.startSample
      ));
    }

    function syncDetectedSilence() {
      const threshold = Number(editState.policy.silenceThresholdDb);
      detectedSilence = candidatesForThreshold(threshold);
      const thresholdControl = document.getElementById('silenceThreshold');
      if ([...thresholdControl.options].some(option => Number(option.value) === threshold)) {
        thresholdControl.value = String(threshold);
      }
    }

    function setSilenceThresholdDb(value) {
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) throw new Error('静音阈值必须是有限 dB 数值');
      pushUndo();
      editState = EditState.transitionEditState(editState, {
        type: 'SET_POLICY',
        patch: { silenceThresholdDb: threshold },
      });
      syncDetectedSilence();
      renderTranscript();
      return refreshPlan();
    }

    function clearAll() {
      pushUndo();
      const restoredWords = [...new Set([
        ...editState.explicitlyRestoredWordIds,
        ...editState.currentDeletedWordIds,
      ])].sort();
      editState = EditState.createEditState({
        ...editState,
        currentDeletedWordIds: [],
        manualDeleteRanges: [],
        explicitlyRestoredWordIds: restoredWords,
        explicitlyRestoredSilenceIds: allDetectedSilence.map(item => String(item.id)),
        explicitlyRestoredSilenceRanges: allDetectedSilence.map(item => ({
          silenceId: String(item.id),
          startSample: item.startSample,
          endSample: item.endSample,
        })),
      });
      refreshPlan();
    }

    function drawBand(context, items, color, sampleToX, height) {
      context.fillStyle = color;
      for (const item of items) {
        const startSample = item.reviewStartSample == null ? item.startSample : item.reviewStartSample;
        const endSample = item.reviewEndSample == null ? item.endSample : item.reviewEndSample;
        const x0 = sampleToX(startSample);
        const x1 = sampleToX(endSample);
        context.fillRect(x0, 0, Math.max(1, x1 - x0), height);
      }
    }

    function drawRuler(sampleToX, width) {
      if (!rulerCanvas) return;
      const height = rulerCanvas.clientHeight || 20;
      const ratio = root.devicePixelRatio || 1;
      rulerCanvas.width = Math.round(width * ratio);
      rulerCanvas.height = Math.round(height * ratio);
      const context = rulerCanvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = '#1A1A1F';
      context.fillRect(0, 0, width, height);
      const visibleSamples = durationSamples() / waveScale;
      const stepSeconds = visibleSamples / sampleRate() > 120 ? 30 : 5;
      const stepSamples = stepSeconds * sampleRate();
      context.fillStyle = '#6B6557';
      context.font = '10px monospace';
      for (let sample = Math.ceil(waveStartSample / stepSamples) * stepSamples;
        sample <= waveStartSample + visibleSamples; sample += stepSamples) {
        const x = sampleToX(sample);
        if (x < 0 || x > width) continue;
        context.fillRect(x, height - 6, 1, 6);
        context.fillText(formatSample(sample), x + 3, 10);
      }
    }

    function waveGeometry() {
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || 132;
      const ratio = root.devicePixelRatio || 1;
      const visibleSamples = durationSamples() / waveScale;
      const maximumStart = Math.max(0, durationSamples() - visibleSamples);
      waveStartSample = Math.max(0, Math.min(waveStartSample, maximumStart));
      return {
        width,
        height,
        ratio,
        visibleSamples,
        sampleToX: sample => (sample - waveStartSample) / visibleSamples * width,
      };
    }

    function currentWaveTheme() {
      return WAVE_THEMES[document.getElementById('themeSelect').value] || WAVE_THEMES.cool;
    }

    function applyWaveTheme() {
      const theme = currentWaveTheme();
      document.getElementById('lg-silence').style.background = theme.silence;
      document.getElementById('lg-del').style.background = theme.delEdge;
      document.getElementById('lg-cut').style.background = theme.cutEdge;
      drawWave();
    }

    function drawPlayhead(playheadSample, geometry = waveGeometry()) {
      if (!playheadCanvas) return;
      const pixelWidth = Math.round(geometry.width * geometry.ratio);
      const pixelHeight = Math.round(geometry.height * geometry.ratio);
      if (playheadCanvas.width !== pixelWidth) playheadCanvas.width = pixelWidth;
      if (playheadCanvas.height !== pixelHeight) playheadCanvas.height = pixelHeight;
      const context = playheadCanvas.getContext('2d');
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.setTransform(geometry.ratio, 0, 0, geometry.ratio, 0, 0);
      const sample = playheadSample == null
        ? playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds())
        : playheadSample;
      const headX = geometry.sampleToX(sample);
      if (headX >= 0 && headX <= geometry.width) {
        context.fillStyle = currentWaveTheme().head;
        context.fillRect(headX, 0, 1.5, geometry.height);
      }
      waveRenderStats.playheadRenders += 1;
    }

    function drawWave(playheadSample) {
      if (!canvas || !peaksData || !compiledCutPlan) return;
      const theme = currentWaveTheme();
      const geometry = waveGeometry();
      const { width, height, ratio, visibleSamples, sampleToX } = geometry;
      const nextBackgroundKey = JSON.stringify([
        width,
        height,
        ratio,
        waveScale,
        waveStartSample,
        planRevision,
        editState.policy.silenceThresholdDb,
        document.getElementById('themeSelect').value,
      ]);
      canvas.dataset.cutTicks = JSON.stringify(compiledCutPlan.cuts.map(cut => [
        cut.sourceStartTick,
        cut.sourceEndTick,
      ]));
      canvas.dataset.viewStartSample = String(Math.round(waveStartSample));
      canvas.dataset.visibleSamples = String(Math.round(visibleSamples));
      if (waveBackgroundKey !== nextBackgroundKey) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.fillStyle = theme.bg;
        context.fillRect(0, 0, width, height);
        drawBand(context, detectedSilence, theme.silence, sampleToX, height);
        const values = peaksData.values;
        context.fillStyle = theme.wave;
        const middle = height / 2;
        for (let x = 0; x < width; x += 1) {
          const start = waveStartSample + x / width * visibleSamples;
          const end = waveStartSample + (x + 1) / width * visibleSamples;
          const first = Math.max(0, Math.floor(start / peaksData.bucketSamples));
          const last = Math.min(values.length - 1, Math.ceil(end / peaksData.bucketSamples));
          let peak = 0;
          for (let index = first; index <= last; index += 1) {
            peak = Math.max(peak, values[index] || 0);
          }
          const half = Math.max(0.5, peak * (height - 6) / 2);
          context.fillRect(x, middle - half, 1, half * 2);
        }
        drawBand(context, compiledCutPlan.cuts, theme.cut, sampleToX, height);
        const deleted = new Set(editState.currentDeletedWordIds);
        drawBand(
          context,
          words.filter(word => deleted.has(word.id)),
          theme.del,
          sampleToX,
          height,
        );
        drawRuler(sampleToX, width);
        waveBackgroundKey = nextBackgroundKey;
        waveRenderStats.backgroundRenders += 1;
      }
      drawPlayhead(playheadSample, geometry);
      const slider = document.getElementById('zoomSlider');
      if (slider) {
        slider.value = String(Math.round(Math.log(waveScale) / Math.log(400) * 1000));
      }
    }

    function setWaveScale(nextScale, anchorSample) {
      const next = Math.max(1, Math.min(400, Number(nextScale) || 1));
      const oldVisible = durationSamples() / waveScale;
      const anchor = Number.isFinite(anchorSample)
        ? anchorSample
        : playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds());
      const ratio = oldVisible > 0 ? (anchor - waveStartSample) / oldVisible : 0;
      waveScale = next;
      waveStartSample = anchor - ratio * (durationSamples() / waveScale);
      drawWave(anchor);
    }

    function initWaveAndPanelInteractions() {
      const slider = document.getElementById('zoomSlider');
      if (slider) {
        slider.addEventListener('input', () => {
          setWaveScale(Math.pow(400, Number(slider.value) / 1000));
        });
      }
      canvas.addEventListener('wheel', event => {
        event.preventDefault();
        const rectangle = canvas.getBoundingClientRect();
        const visibleSamples = durationSamples() / waveScale;
        const anchor = waveStartSample
          + (event.clientX - rectangle.left) / rectangle.width * visibleSamples;
        setWaveScale(waveScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), anchor);
      }, { passive: false });
      let drag = null;
      canvas.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, startSample: waveStartSample, moved: false };
      });
      document.addEventListener('mousemove', event => {
        if (!drag) return;
        const delta = event.clientX - drag.x;
        if (Math.abs(delta) > 3) drag.moved = true;
        if (!drag.moved || waveScale <= 1) return;
        const width = canvas.getBoundingClientRect().width || 1;
        waveStartSample = drag.startSample - delta / width * (durationSamples() / waveScale);
        drawWave();
      });
      document.addEventListener('mouseup', () => {
        if (!drag) return;
        suppressWaveClick = drag.moved;
        drag = null;
      });

      const resizer = document.getElementById('resizer');
      const sidePanel = document.querySelector('.side-panel');
      let resizingSide = false;
      resizer.addEventListener('mousedown', event => {
        resizingSide = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        event.preventDefault();
      });
      document.addEventListener('mousemove', event => {
        if (!resizingSide) return;
        const rectangle = document.querySelector('.stage').getBoundingClientRect();
        const width = Math.max(300, Math.min(rectangle.right - event.clientX, rectangle.width - 360));
        sidePanel.style.width = `${width}px`;
      });
      document.addEventListener('mouseup', () => {
        if (!resizingSide) return;
        resizingSide = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });

      const dockResizer = document.getElementById('dockResizer');
      let dockDrag = null;
      const currentWaveHeight = () => Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--wave-h'),
        10,
      ) || 132;
      const setWaveHeight = height => {
        const maximum = Math.max(70, root.innerHeight - 64 - 64 - 200);
        const bounded = Math.round(Math.max(70, Math.min(height, maximum)));
        document.documentElement.style.setProperty('--wave-h', `${bounded}px`);
        drawWave();
      };
      dockResizer.addEventListener('mousedown', event => {
        dockDrag = { y: event.clientY, height: currentWaveHeight() };
        dockResizer.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        event.preventDefault();
      });
      document.addEventListener('mousemove', event => {
        if (dockDrag) setWaveHeight(dockDrag.height + dockDrag.y - event.clientY);
      });
      document.addEventListener('mouseup', () => {
        if (!dockDrag) return;
        dockDrag = null;
        dockResizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }

    function updatePlayhead(reviewSample) {
      const bounded = Math.max(0, Math.min(durationSamples(), reviewSample));
      let viewportChanged = false;
      if (waveScale > 1) {
        const visible = durationSamples() / waveScale;
        if (bounded < waveStartSample || bounded > waveStartSample + visible * 0.85) {
          waveStartSample = bounded - visible * 0.15;
          viewportChanged = true;
        }
      }
      timeCurrent.textContent = formatSample(bounded);
      if (currentWordElement) currentWordElement.classList.remove('current');
      const word = words.find(item => bounded >= item.startSample && bounded < item.endSample);
      currentWordElement = word
        ? content.querySelector(`[data-word-id="${CSS.escape(word.id)}"]`)
        : null;
      if (currentWordElement) currentWordElement.classList.add('current');
      updateTitlePreview(bounded);
      if (viewportChanged) drawWave(bounded);
      else drawPlayhead(bounded);
    }

    function tick() {
      rafId = 0;
      if (player.paused) return;
      const reviewSample = playerSecondsToReviewSample(player.currentTime);
      if (previewRange) {
        if (reviewSample >= previewRange.endSample) {
          player.pause();
          endPreview();
          return;
        }
      } else {
        processPlaybackSample(reviewSample, true);
      }
      updatePlayhead(reviewSample);
      rafId = root.requestAnimationFrame(tick);
    }

    function startTick() {
      if (!rafId) rafId = root.requestAnimationFrame(tick);
    }

    async function exportNow() {
      if (!api.ready || !mediaCapabilityReady) throw new Error(mediaFailure || api.error || '浏览器媒体能力尚未验证');
      if (api.error || !compiledCutPlan) throw new Error(api.error || 'compiledCutPlan 尚未就绪');
      lastExportPayload = {
        compiledCutPlan,
        includeTitles: includeTitles.checked,
      };
      const response = await fetch('/api/fcpxml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastExportPayload),
      });
      let result = {};
      try {
        result = await response.json();
      } catch (_error) {
        const failure = new Error(`导出服务返回无效响应: HTTP ${response.status}`);
        failure.permanent = response.status >= 400 && response.status < 500;
        throw failure;
      }
      if (!response.ok || !result.success) {
        const failure = new Error(result.error || `HTTP ${response.status}`);
        failure.permanent = response.status >= 400 && response.status < 500;
        throw failure;
      }
      if (result.downloadUrl !== '/api/download/fcpxml') {
        throw new Error('服务端未返回当前 FCPXML 下载地址');
      }
      const download = await fetch(result.downloadUrl);
      if (!download.ok) throw new Error(`下载 FCPXML 失败: HTTP ${download.status}`);
      const blob = await download.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.output.split('/').pop();
      anchor.click();
      URL.revokeObjectURL(url);
      if (typeof root.alert === 'function') {
        root.alert(`✅ FCPXML 已导出\n\n保留片段: ${result.segments} 个`);
      }
      return result;
    }

    async function requestExport() {
      try {
        api.lastExportError = null;
        return await exportNow();
      } catch (error) {
        api.lastExportError = error instanceof Error ? error.message : String(error);
        if (error && error.permanent === true) failClosed(error);
        else if (api.ready && mediaCapabilityReady) {
          exportButton.disabled = false;
          exportButton.title = `上次导出失败，可重试: ${api.lastExportError}`;
        }
        if (typeof root.alert === 'function') root.alert(`❌ 导出失败: ${api.lastExportError}`);
        return null;
      }
    }

    function initTranscriptInteractions() {
      let pending = null;
      let suppressClick = false;
      content.addEventListener('mousedown', event => {
        const node = event.target.closest('[data-word-id]');
        if (!node || event.button !== 0) return;
        const wordId = node.dataset.wordId;
        pending = {
          wordId,
          x: event.clientX,
          y: event.clientY,
          mode: editState.currentDeletedWordIds.includes(wordId) ? 'restore' : 'delete',
          active: false,
        };
        event.preventDefault();
      });
      document.addEventListener('mousemove', event => {
        if (!pending) return;
        if (!pending.active && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 4) return;
        const target = event.target.closest('[data-word-id]');
        if (!target) return;
        if (!pending.active) {
          pending.active = true;
          pushUndo();
        }
        const start = words.findIndex(word => word.id === pending.wordId);
        const end = words.findIndex(word => word.id === target.dataset.wordId);
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        let next = editState;
        for (let index = low; index <= high; index += 1) {
          next = EditState.transitionEditState(next, {
            type: pending.mode === 'delete' ? 'DELETE_WORD' : 'RESTORE_WORD',
            wordId: words[index].id,
          });
        }
        editState = next;
        refreshPlan();
        suppressClick = true;
      });
      document.addEventListener('mouseup', () => { pending = null; });
      content.addEventListener('click', event => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        const gapNode = event.target.closest('[data-asr-break-id], [data-silence-id]');
        if (gapNode) {
          if (gapNode.dataset.silenceId) toggleSilence(gapNode.dataset.silenceId);
          else toggleManualDeleteRange(gapNode);
          return;
        }
        const wordNode = event.target.closest('[data-word-id]');
        if (!wordNode) return;
        const word = words.find(item => item.id === wordNode.dataset.wordId);
        const cut = cutAtSample(Math.round((word.startSample + word.endSample) / 2));
        if (cut) beginPreview({
          startSample: cut.reviewStartSample,
          endSample: cut.reviewEndSample,
        }, true);
        else {
          seekReviewSample(word.startSample);
          player.play().catch(failMedia);
        }
      });
      content.addEventListener('dblclick', event => {
        const wordNode = event.target.closest('[data-word-id]');
        if (!wordNode) return;
        const wordId = wordNode.dataset.wordId;
        const deleted = editState.currentDeletedWordIds.includes(wordId);
        dispatch({ type: deleted ? 'RESTORE_WORD' : 'DELETE_WORD', wordId });
      });
    }

    function initControls() {
      player.addEventListener('play', () => {
        document.getElementById('playBtn').textContent = '❚❚ 暂停';
        startTick();
      });
      player.addEventListener('pause', () => {
        document.getElementById('playBtn').textContent = '▶ 播放';
        updatePlayhead(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
      });
      player.addEventListener('seeked', () => {
        acknowledgePendingSeek();
        updatePlayhead(playerSecondsToReviewSample(player.currentTime));
        if (!player.paused) startTick();
      });
      player.addEventListener('error', () => {
        failMedia(root.ReviewMediaCapability.describeError(player));
      });
      canvas.addEventListener('click', event => {
        if (suppressWaveClick) {
          suppressWaveClick = false;
          return;
        }
        const rectangle = canvas.getBoundingClientRect();
        const visibleSamples = durationSamples() / waveScale;
        const sample = waveStartSample + (event.clientX - rectangle.left) / rectangle.width * visibleSamples;
        seekReviewSample(sample);
      });
      const frameRate = mediaContext.timebase.kind === 'video-frames'
        ? mediaContext.timebase.fpsNum / mediaContext.timebase.fpsDen
        : 30;
      const updatePadding = () => {
        const startFrames = Number(document.getElementById('knob-padstart').value);
        const endFrames = Number(document.getElementById('knob-padend').value);
        document.getElementById('knob-padstart-val').textContent = `${startFrames} 帧`;
        document.getElementById('knob-padend-val').textContent = `${endFrames} 帧`;
        dispatch({
          type: 'SET_POLICY',
          patch: {
            silencePaddingStartSamples: Math.round(startFrames / frameRate * sampleRate()),
            silencePaddingEndSamples: Math.round(endFrames / frameRate * sampleRate()),
          },
        });
      };
      document.getElementById('knob-padstart').addEventListener('input', updatePadding);
      document.getElementById('knob-padend').addEventListener('input', updatePadding);
      includeTitles.addEventListener('change', () => {
        updateTitlePreview(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
      });
      const themeSelect = document.getElementById('themeSelect');
      themeSelect.innerHTML = '<option value="cool">冷调蓝白</option><option value="mint">薄荷青</option><option value="recut">Recut 暖灰</option>';
      themeSelect.addEventListener('change', applyWaveTheme);
      applyWaveTheme();
      root.addEventListener('resize', () => drawWave());
      document.addEventListener('keydown', event => {
        if (!api.ready || !mediaCapabilityReady) return;
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
        if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ') {
          event.preventDefault();
          undo();
        } else if (!event.metaKey && !event.ctrlKey && event.code === 'Space') {
          event.preventDefault();
          root.togglePlay();
        } else if (!event.metaKey && !event.ctrlKey && event.code === 'ArrowLeft') {
          event.preventDefault();
          root.seekRel(event.shiftKey ? -5 : -1);
        } else if (!event.metaKey && !event.ctrlKey && event.code === 'ArrowRight') {
          event.preventDefault();
          root.seekRel(event.shiftKey ? 5 : 1);
        }
      });
      initTranscriptInteractions();
      initWaveAndPanelInteractions();
    }

    async function initialize() {
      try {
        if (!EditState || !CompileEdit || !SubtitleBlocks || !root.ReviewMediaCapability) {
          throw new Error('审核工作台共享模块未加载');
        }
        const fetchJson = async file => {
          const response = await fetch(file);
          if (!response.ok) throw new Error(`${file} 未找到 (HTTP ${response.status})`);
          return response.json();
        };
        const [data, peaks, silence] = await Promise.all([
          fetchJson('./data.json'),
          fetchJson('./peaks.json'),
          fetchJson('./detected_silence.json'),
        ]);
        words = data.words;
        asrBreaks = data.asrBreaks;
        allDetectedSilence = silence;
        peaksData = peaks;
        mediaContext = data.mediaContext;
        if (!Array.isArray(words) || !Array.isArray(asrBreaks) || !Array.isArray(allDetectedSilence)
            || !Array.isArray(data.silenceThresholds)
            || !peaksData || !Array.isArray(peaksData.values)) {
          throw new Error('审核数据缺少 words/asrBreaks/detectedSilence/sample-domain peaks');
        }
        if (peaksData.decodedSampleCount !== mediaContext.review.decodedSampleCount
            || peaksData.sampleRate !== mediaContext.review.sampleRate) {
          throw new Error('peaks sample clock 与 media context 不一致');
        }
        const playerOffset = mediaContext.offsets && mediaContext.offsets.playerPresentationOffset;
        if (!playerOffset || playerOffset.status !== 'verified'
            || !Number.isFinite(playerOffset.seconds)) {
          throw new Error('playerPresentationOffset 未验证');
        }
        loadingLabel.textContent = '检查浏览器媒体能力';
        loadingTime.textContent = '正在验证媒体加载与定位，请稍候';
        await root.ReviewMediaCapability.probe(player, { mediaContext });
        mediaCapabilityReady = true;
        const initialThreshold = Number(document.getElementById('silenceThreshold').value);
        if (!data.silenceThresholds.map(Number).includes(initialThreshold)
            || allDetectedSilence.some(item => !data.silenceThresholds.map(Number).includes(Number(item.thresholdDb)))) {
          throw new Error('detectedSilence 阈值变体与工作台合同不一致');
        }
        detectedSilence = candidatesForThreshold(initialThreshold);
        const frameRate = mediaContext.timebase.kind === 'video-frames'
          ? mediaContext.timebase.fpsNum / mediaContext.timebase.fpsDen
          : 30;
        const startPaddingFrames = Number(document.getElementById('knob-padstart').value);
        const endPaddingFrames = Number(document.getElementById('knob-padend').value);
        editState = EditState.createEditState({
          initialSuggestedWordDeletes: data.initialSuggestedWordDeletes,
          policy: {
            silenceThresholdDb: initialThreshold,
            minimumSilenceSamples: Math.round(0.2 * mediaContext.review.sampleRate),
            silencePaddingStartSamples:
              Math.round(startPaddingFrames / frameRate * mediaContext.review.sampleRate),
            silencePaddingEndSamples:
              Math.round(endPaddingFrames / frameRate * mediaContext.review.sampleRate),
          },
        });
        renderTranscript();
        initControls();
        if (!refreshPlan()) return;
        timeTotal.textContent = formatSample(durationSamples());
        document.getElementById('fileSub').innerHTML = `REVIEW <span class="dot">●</span> ${editState.initialSuggestedWordDeletes.length} 处 AI 语言预选`;
        loadingOverlay.classList.remove('show');
        api.ready = true;
        setReviewInteractionEnabled(true);
        updatePlayhead(0);
      } catch (error) {
        failClosed(error);
      }
    }

    root.togglePlay = () => {
      if (!api.ready || !mediaCapabilityReady) return;
      endPreview();
      if (player.paused) player.play().catch(failMedia);
      else player.pause();
    };
    root.setSpeed = value => { player.playbackRate = Number(value); };
    root.seekRel = seconds => {
      const current = playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds());
      seekReviewSample(current + Number(seconds) * sampleRate());
    };
    root.applySilenceThreshold = value => setSilenceThresholdDb(value);
    root.exportFCPXML = requestExport;
    root.clearAll = clearAll;
    root.waveZoom = factor => setWaveScale(waveScale * Number(factor));
    root.waveZoomFit = () => {
      waveStartSample = 0;
      setWaveScale(1, 0);
    };

    Object.assign(api, {
      getEditState: () => clone(editState),
      getPlan: () => compiledCutPlan,
      getMediaContext: () => clone(mediaContext),
      dispatch,
      undo,
      toggleSilence,
      setSilenceThresholdDb,
      isReviewSampleAudible,
      reviewSampleToPlayerSeconds,
      playerSecondsToReviewSample,
      seekReviewSample,
      processPlaybackSample,
      beginPreview: range => beginPreview(range, false),
      endPreview,
      resetSeekProbe() {
        latchedCutId = null;
        pendingSeek = null;
        seekWrites = {};
      },
      getSeekWrites: () => clone(seekWrites),
      getPendingSeek: () => clone(pendingSeek),
      updatePlayheadForTest: updatePlayhead,
      getTitlePreview() {
        return {
          visible: titlePreview.classList.contains('visible'),
          text: titlePreview.textContent,
          titleId: titlePreview.dataset.titleId,
          outputStartTick: titlePreview.dataset.outputStartTick,
          outputEndTick: titlePreview.dataset.outputEndTick,
        };
      },
      getWaveViewport() {
        return {
          scale: waveScale,
          startSample: Number(canvas.dataset.viewStartSample),
          visibleSamples: Number(canvas.dataset.visibleSamples),
        };
      },
      getWaveRenderStats: () => clone(waveRenderStats),
      getDomSeparation() {
        const asrBreakIds = [...content.querySelectorAll('[data-asr-break-id]')]
          .map(node => node.dataset.asrBreakId);
        const detectedSilenceIds = [...content.querySelectorAll('[data-silence-id]')]
          .map(node => node.dataset.silenceId);
        return {
          asrBreakIds,
          detectedSilenceIds,
          overlapIds: asrBreakIds.filter(id => detectedSilenceIds.includes(id)),
        };
      },
      getConsumerConsistency() {
        const visibleTitle = titlePreview.classList.contains('visible')
          ? {
            id: titlePreview.dataset.titleId,
            outputStartTick: Number(titlePreview.dataset.outputStartTick),
            outputEndTick: Number(titlePreview.dataset.outputEndTick),
          }
          : null;
        return {
          sameObject: Object.values(consumerPlans).every(plan => plan === compiledCutPlan),
          revision: planRevision,
          waveCutTicks: JSON.parse(canvas.dataset.cutTicks || '[]'),
          playbackCuts: consumerPlans.playback && consumerPlans.playback.cuts,
          visibleTitle,
          exportKeeps: consumerPlans.export && consumerPlans.export.keeps,
        };
      },
      exportNow,
      requestExport,
      getLastExportPayload: () => lastExportPayload,
      replaceMediaContextForTest(nextContext) {
        mediaContext = nextContext;
        refreshPlan();
      },
    });

    loadingOverlay.classList.add('show');
    exportButton.disabled = true;
    initialize();
    return api;
  }

  return { mount };
});
