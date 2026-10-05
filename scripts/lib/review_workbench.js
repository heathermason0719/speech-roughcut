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

  const DEFAULT_PAUSE_DISPLAY_MILLISECONDS = 700;

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

  // Presentation only: retain every original range and its reason-specific action.
  function buildLegacyPauseGroups({ words, asrBreaks, detectedSilence }) {
    const evidence = [
      ...asrBreaks.map(item => ({ kind: 'asr', item })),
      ...detectedSilence.map(item => ({ kind: 'pcm', item })),
    ].sort((a, b) => a.item.startSample - b.item.startSample || a.item.endSample - b.item.endSample);
    const slots = new Map();
    for (const entry of evidence) {
      const item = entry.item;
      let previousIndex = -1;
      for (let index = 0; index < words.length; index += 1) {
        if (words[index].endSample <= item.startSample) previousIndex = index;
        else break;
      }
      const anchorWordId = previousIndex < 0 ? null : words[previousIndex].id;
      const nextWord = words[previousIndex + 1];
      const withinGap = !nextWord || item.endSample <= nextWord.startSample;
      if (!slots.has(anchorWordId)) slots.set(anchorWordId, []);
      const groups = slots.get(anchorWordId);
      const previous = groups[groups.length - 1];
      if (withinGap && previous?.withinGap && item.startSample <= previous.endSample) {
        previous.endSample = Math.max(previous.endSample, item.endSample);
        previous.evidence.push(entry);
      } else {
        groups.push({ anchorWordId, withinGap, startSample: item.startSample,
          endSample: item.endSample, evidence: [entry] });
      }
    }
    return [...slots.values()].flat().sort((a, b) => a.startSample - b.startSample);
  }

  // Navigation extents are never implicit deletion ranges.
  function buildPauseGroups({ words, asrBreaks, detectedSilence }) {
    const evidence = [
      ...asrBreaks.map(item => ({ kind: 'asr', item })),
      ...detectedSilence.map(item => ({ kind: 'pcm', item })),
    ].sort((a, b) => a.item.startSample - b.item.startSample || a.item.endSample - b.item.endSample);
    const groups = [];
    for (const entry of evidence) {
      const previous = groups[groups.length - 1];
      if (previous && entry.item.startSample <= previous.endSample) {
        previous.endSample = Math.max(previous.endSample, entry.item.endSample);
        previous.evidence.push(entry);
      } else groups.push({ startSample: entry.item.startSample, endSample: entry.item.endSample, evidence: [entry] });
    }
    for (const group of groups) {
      group.id = `pause-${group.startSample}-${group.endSample}`;
      group.anchorWordId = null;
      for (const word of words) if (word.endSample <= group.startSample) group.anchorWordId = word.id;
    }
    return groups;
  }

  function mount() {
    const api = {
      ready: false,
      error: null,
    };
    root.__reviewTest = api;

    const player = document.getElementById('player');
    const content = document.getElementById('content');
    const transcriptScroll = content.closest('.transcript-scroll');
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
    let audioSuggestions = [];
    let seamPreparation = null;
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
    let redoStack = [];
    let previousPlaybackSample = null;
    let previewRange = null;
    let latchedCutId = null;
    let pendingSeek = null;
    let seekWrites = {};
    let rafId = 0;
    let currentWordElement = null;
    let followedWordElement = null;
    let waveScale = 1;
    let waveStartSample = 0;
    let suppressWaveClick = false;
    let waveBackgroundKey = '';
    let rangeEditor = null;
    let suggestionEditor = null;
    let selectedPause = null;
    let showShortPauses = false;
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
    const usesRangeEditing = () => ['conservative-v1', 'narration-v1'].includes(editState?.policy.version);
    const effectiveAudioSuggestions = () => editState?.policy.version === 'narration-v1'
      ? root.AudioSuggestions.resolveAudioSuggestions(audioSuggestions, editState, durationSamples()) : [];
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
      player.pause();
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

    function handlePlayError(error) {
      // A user pause or a new audition can cancel an outstanding play request.
      // Decode/load failures still arrive through failMedia and the media error event.
      if (error?.name !== 'AbortError') failMedia(error);
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

    function syncControls() {
      syncDetectedSilence();
      const fps = mediaContext.timebase.kind === 'video-frames'
        ? mediaContext.timebase.fpsNum / mediaContext.timebase.fpsDen : 30;
      for (const [id, key] of [['padstart', 'silencePaddingStartSamples'], ['padend', 'silencePaddingEndSamples']]) {
        const frames = editState.policy[key] / sampleRate() * fps;
        document.getElementById(`knob-${id}`).value = String(frames);
        document.getElementById(`knob-${id}-val`).textContent = `${frames} 帧`;
      }
    }

    function resetPlaybackState() {
      previewRange = null;
      latchedCutId = null;
      pendingSeek = null;
      previousPlaybackSample = null;
    }

    function reportEditError(error) {
      api.lastEditError = error instanceof Error ? error.message : String(error);
      if (editState && mediaContext) syncControls();
      exportButton.title = `编辑未应用: ${api.lastEditError}`;
    }

    function commitState(candidate, record = true, fatal = false) {
      if (api.error && !fatal) return null;
      const previous = { editState, detectedSilence, compiledCutPlan, planRevision };
      try {
        if (!mediaCapabilityReady) throw new Error(mediaFailure || '浏览器媒体能力尚未验证');
        const nextState = EditState.createEditState(candidate);
        const nextSilence = candidatesForThreshold(nextState.policy.silenceThresholdDb);
        const nextPlan = CompileEdit.compileEdit({ words, asrBreaks, detectedSilence: nextSilence, audioSuggestions,
          editState: nextState, mediaContext });
        editState = nextState;
        detectedSilence = nextSilence;
        compiledCutPlan = nextPlan;
        planRevision += 1;
        syncControls();
        if (!previous.compiledCutPlan || Number(previous.editState.policy.silenceThresholdDb)
            !== Number(nextState.policy.silenceThresholdDb)
            || usesRangeEditing() && (JSON.stringify(previous.editState.manualDeleteRanges) !== JSON.stringify(nextState.manualDeleteRanges)
              || JSON.stringify(previous.editState.audioSuggestionRanges) !== JSON.stringify(nextState.audioSuggestionRanges))) renderTranscript();
        setConsumerPlan(nextPlan);
        refreshSelectionStyles();
        if (rangeEditor) rangeEditor.refresh();
        if (suggestionEditor) suggestionEditor.refresh();
        renderSeamAudit();
        drawWave();
        document.getElementById('tl-total').textContent = formatSample(durationSamples());
        document.getElementById('tl-final').textContent = formatSeconds(currentOutputSeconds());
        updateTitlePreview(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
        if (record) { undoStack.push(clone(previous.editState)); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
        resetPlaybackState();
        if (!player.paused) processPlaybackSample(playerSecondsToReviewSample(player.currentTime));
        api.lastEditError = null;
        exportButton.disabled = false;
        exportButton.title = '';
        return nextPlan;
      } catch (error) {
        editState = previous.editState;
        detectedSilence = previous.detectedSilence;
        compiledCutPlan = previous.compiledCutPlan;
        planRevision = previous.planRevision;
        if (compiledCutPlan) {
          setConsumerPlan(compiledCutPlan);
          renderTranscript();
          drawWave();
          updateTitlePreview(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
        }
        if (fatal) failClosed(error); else reportEditError(error);
        return null;
      }
    }

    function refreshPlan() { return commitState(editState, false, true); }

    function renderSeamAudit() {
      if (!root.SeamPreparation || !compiledCutPlan) return;
      const audit = root.SeamPreparation.auditSeams({plan:compiledCutPlan,words,editState,
        preparation:seamPreparation,audioSuggestions});
      api.getSeamAudit = () => clone(audit);
      const panel = document.getElementById('seamAudit');
      if (!panel) return;
      panel.replaceChildren(); panel.hidden = false;
      const details = document.createElement('details'), summary = document.createElement('summary');
      const changed = audit.seamReviews.filter(s=>s.status==='user-edited');
      summary.textContent = `接缝复核 · ${audit.fragments.length} 处独立片段 · ${changed.length} 处编辑后需复核`;
      details.append(summary);
      const note = document.createElement('p'); note.textContent = '复核只报告声音片段，不改变剪辑。试听原声后可调整已有决定；剪后效果用播放器试听。'; details.append(note);
      const labels = {'intentional':'明确保留','pending':'待听','user-edited':'编辑后需复核','preparation-failed':'准备失败','resolved':'接缝待听审'};
      const preciseTime = sample => {
        const seconds = sample / sampleRate();
        return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${(seconds % 60).toFixed(3).padStart(6,'0')}`;
      };
      const add = (item, kind) => {
        const row = document.createElement('p'); row.dataset.auditStatus = item.status;
        row.append(`${preciseTime(item.startSample)}–${preciseTime(item.endSample)} ${kind} · ${labels[item.status]} · ${item.reason} `);
        for (const [label, action] of [['定位',()=>locateAudioRange(item)],['原声',()=>{locateAudioRange(item);beginPreview(item,true);}]]) {
          const button = document.createElement('button'); button.type='button';button.textContent=label;button.addEventListener('click',action);row.append(button);
        }
        details.append(row);
      };
      audit.fragments.forEach(item=>add(item,'独立片段'));
      audit.seamReviews.forEach(item=>add(item,'接缝'));
      panel.append(details);
    }

    function dispatch(action, record = true) {
      if (api.error) return null;
      try { return commitState(EditState.transitionEditState(editState, action), record); }
      catch (error) { reportEditError(error); return null; }
    }

    function dispatchBatch(actions, record = true) {
      if (api.error) return null;
      try { return commitState(actions.reduce((state, action) => EditState.transitionEditState(state, action), editState), record); }
      catch (error) { reportEditError(error); return null; }
    }

    function undo() {
      if (api.error || !undoStack.length) return compiledCutPlan;
      const before = clone(editState);
      const result = commitState(undoStack[undoStack.length - 1], false);
      if (result) { undoStack.pop(); redoStack.push(before); }
      return result;
    }

    function redo() {
      if (api.error || !redoStack.length) return compiledCutPlan;
      const before = clone(editState);
      const result = commitState(redoStack[redoStack.length - 1], false);
      if (result) { redoStack.pop(); undoStack.push(before); }
      return result;
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
      const lastSample = previousPlaybackSample;
      previousPlaybackSample = sample;
      const cut = cutAtSample(sample) || (lastSample !== null && sample > lastSample
        ? compiledCutPlan.cuts.find(item => item.reviewStartSample > lastSample && item.reviewEndSample <= sample)
        : null);
      if (!cut) {
        latchedCutId = null;
        return null;
      }
      if (latchedCutId === cut.id) return null;
      latchedCutId = cut.id;
      pendingSeek = { cutId: cut.id, targetSample: cut.reviewEndSample };
      previousPlaybackSample = cut.reviewEndSample;
      seekWrites[cut.id] = (seekWrites[cut.id] || 0) + 1;
      if (performSeek) {
        if (cut.reviewEndSample >= durationSamples()) player.pause();
        player.currentTime = reviewSampleToPlayerSeconds(cut.reviewEndSample);
      }
      return cut.reviewEndSample;
    }

    function acknowledgePendingSeek() {
      const completed = pendingSeek;
      pendingSeek = null;
      if (completed) previousPlaybackSample = completed.targetSample;
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
      if (play) player.play().catch(handlePlayError);
    }

    function endPreview() {
      resetPlaybackState();
    }

    function seekReviewSample(sample) {
      endPreview();
      const bounded = Math.max(0, Math.min(durationSamples(), Math.round(sample)));
      player.currentTime = reviewSampleToPlayerSeconds(bounded);
      updatePlayhead(bounded, true);
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
        [hidden] { display: none !important; }
        .range-body { padding: 14px 18px; color: var(--paper-200); font-size: 13px; }
        .range-body > label { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
        .range-body input[type="text"] { width: 105px; min-width: 0; flex: 1; padding: 6px;
          border: 1px solid var(--line-2); border-radius: 5px; background: var(--ink); color: var(--paper-100); }
        .range-body button { color: var(--paper-200); background: var(--ink-3); border: 1px solid var(--line-2);
          border-radius: 5px; padding: 6px 8px; font: inherit; cursor: pointer; }
        .range-body button:disabled { opacity: .4; cursor: default; }
        .range-body button:hover:not(:disabled) { border-color: var(--ember); }
        .range-body select { min-width: 0; flex: 1; width: 100%; color: var(--paper-200);
          background: var(--ink); border: 1px solid var(--line-2); border-radius: 5px; padding: 6px; }
        #audioSuggestionGroups label { display: flex; gap: 6px; padding: 6px 0; }
        .audio-suggestion-marker.restored { color: var(--paper-500); }
        .range-body button:focus-visible, .pause-marker:focus-visible, .range-marker:focus-visible {
          outline: 2px solid var(--ember); outline-offset: 2px; }
        .range-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .range-hint { color: var(--paper-500); line-height: 1.6; margin: 0 0 10px; }
        #rangeMessage { margin-top: 10px; }
        #deleteRange { border-color: var(--ember); }
        #manualRangeList { max-height: 190px; overflow: auto; }
        .manual-range { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
        .pause-marker, .range-marker { display: inline-flex; vertical-align: baseline; align-items: center;
          justify-content: center; width: 13px; height: 23px; margin: 0 2px; padding: 0; border: 0;
          color: var(--paper-500); background: transparent; cursor: pointer; font: inherit; }
        .pause-marker::before { content: ''; height: 13px; border-left: 2px dotted currentColor; }
        .pause-marker.active, .range-marker { color: var(--ember); }
        .word.audio-partial:not(.selected) { box-shadow: inset 0 -2px var(--ember); }
        .word.audio-full:not(.selected) { text-decoration: line-through; text-decoration-color: var(--ember); opacity: .6; }
        #pauseEvidence { font-size: 12px; line-height: 1.7; color: var(--paper-500); overflow-wrap: anywhere; }
        .paragraph-content { min-width: 0; }
        .pause-list { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 6px;
          font-size: 12px; line-height: 1.6; color: var(--paper-400); }
        .pause-list summary { cursor: pointer; padding: 3px 0; }
        .pause-list summary:hover { color: var(--paper-100); }
        .pause-list summary:focus-visible, .pause-list button:focus-visible {
          outline: 2px solid var(--ember); outline-offset: 2px; }
        .pause-list details[open] { flex-basis: 100%; }
        .pause-actions { padding: 8px 12px; background: var(--ink-3); border-radius: 8px; }
        .pause-actions p { margin: 4px 0; }
        .pause-actions button { cursor: pointer; font: inherit; color: inherit; }
        .pause-list .gap { font: inherit; margin: 4px 8px 4px 0; }
        .pause-audition { border: 1px solid var(--line-2); border-radius: 6px;
          background: var(--ink); padding: 4px 10px; }
        .short-pauses > .pause-group { margin: 5px 0 5px 12px; }
        .pause-status { margin-left: 8px; color: var(--paper-500); }
        .pause-status[data-coverage="full"], .pause-status[data-coverage="partial"] { color: var(--ember); }
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

    function hasManualDeleteRange(range, sourceSilenceId = null) {
      return editState.manualDeleteRanges.some(item => (
        item.startSample === range.startSample && item.endSample === range.endSample
        && (item.sourceSilenceId || null) === sourceSilenceId
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
      const chip = document.createElement('button');
      chip.type = 'button';
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
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gap detected-silence';
      chip.dataset.silenceId = item.id;
      chip.dataset.startSample = item.startSample;
      chip.dataset.endSample = item.endSample;
      chip.textContent = `PCM ${((item.endSample - item.startSample) / sampleRate()).toFixed(1)}s`;
      chip.dataset.baseTitle = `PCM 能量证据 max ${item.energy.maxDb} dB；单击切换自动静音或该标签的删除，词级删除仍生效`;
      chip.title = chip.dataset.baseTitle;
      parent.appendChild(chip);
    }

    function renderPause(group, parent) {
      const details = document.createElement('details');
      details.className = 'pause-group';
      details.dataset.pauseGroup = '';
      details.dataset.startSample = group.startSample;
      details.dataset.endSample = group.endSample;
      const summary = document.createElement('summary');
      const seconds = (group.endSample - group.startSample) / sampleRate();
      summary.append(`停顿 ${seconds < 0.1 ? '<0.1' : seconds.toFixed(1)}s · ${formatSample(group.startSample)}`);
      const status = document.createElement('span');
      status.className = 'pause-status';
      summary.appendChild(status);
      const actions = document.createElement('div');
      actions.className = 'pause-actions';
      const audition = document.createElement('button');
      audition.type = 'button';
      audition.className = 'pause-audition';
      audition.textContent = '▶ 试听原声';
      audition.addEventListener('click', () => beginPreview({
        startSample: group.startSample - sampleRate() * 0.25,
        endSample: group.endSample + sampleRate() * 0.25,
      }, true));
      actions.appendChild(audition);
      const hint = document.createElement('p');
      hint.textContent = '点击下方证据切换原有删除／恢复；恢复静音不会撤销删词或其他手动删除。';
      actions.appendChild(hint);
      for (const entry of group.evidence) {
        if (entry.kind === 'asr') renderAsrBreak(entry.item, actions);
        else renderDetectedSilence(entry.item, actions);
      }
      details.append(summary, actions);
      parent.appendChild(details);
    }

    function locateAudioRange(range) {
      seekReviewSample(range.startSample);
      waveScale = Math.max(1, Math.min(400, durationSamples() / Math.max(4 * sampleRate(), range.endSample - range.startSample + 2 * sampleRate())));
      waveStartSample = Math.max(0, range.startSample - sampleRate());
      drawWave(range.startSample);
    }

    function focusPause(group) {
      selectedPause = group;
      locateAudioRange(group);
      const format = sample => root.AudioRangeEditor.formatTime(sample, sampleRate());
      document.getElementById('pauseLocation').textContent = `${format(group.startSample)}–${format(group.endSample)} · 导航范围，尚未选择删音`;
      document.getElementById('auditionPause').disabled = false;
      const details = document.getElementById('pauseEvidence');
      details.replaceChildren();
      for (const entry of group.evidence) {
        const line = document.createElement('p');
        line.textContent = `${entry.kind.toUpperCase()} ${format(entry.item.startSample)}–${format(entry.item.endSample)}`;
        details.appendChild(line);
      }
      for (const node of content.querySelectorAll('.pause-marker')) {
        node.classList.toggle('active', node.dataset.pauseId === group.id);
        if (node.dataset.pauseId === group.id) node.scrollIntoView({ block: 'nearest' });
      }
    }

    function renderReadableTranscript() {
      content.replaceChildren();
      currentWordElement = null;
      followedWordElement = null;
      const slots = new Map();
      const put = (wordId, item) => {
        if (!slots.has(wordId)) slots.set(wordId, []);
        slots.get(wordId).push(item);
      };
      for (const group of buildPauseGroups({ words, asrBreaks, detectedSilence })) put(group.anchorWordId, { group });
      for (const range of editState.manualDeleteRanges) {
        let anchor = null;
        for (const word of words) if (word.endSample <= range.startSample) anchor = word.id;
        put(anchor, { range });
      }
      for (const suggestion of effectiveAudioSuggestions()) {
        let anchor = null;
        for (const word of words) if (word.endSample <= suggestion.startSample) anchor = word.id;
        put(anchor, { range:suggestion, suggestion:true });
      }
      const addMarkers = (wordId, parent) => {
        for (const item of slots.get(wordId) || []) {
          const range = item.range || item.group;
          const marker = document.createElement('button');
          marker.type = 'button';
          marker.className = item.group ? 'pause-marker' : item.suggestion ? 'range-marker audio-suggestion-marker' : 'range-marker';
          marker.dataset.startSample = range.startSample;
          marker.dataset.endSample = range.endSample;
          const time = root.AudioRangeEditor.formatTime(range.startSample, sampleRate());
          marker.title = `${item.group ? '停顿候选' : item.suggestion ? '自动音频建议' : '已删除音频范围'} · ${time} · 点击定位`;
          marker.setAttribute('aria-label', marker.title);
          if (item.group) {
            marker.dataset.pauseId = range.id;
            marker.classList.toggle('active', selectedPause?.id === range.id);
            marker.addEventListener('click', () => focusPause(range));
          } else if (item.suggestion) {
            marker.dataset.suggestionId = range.id; marker.textContent = '·';
            marker.addEventListener('click', () => suggestionEditor.focus(range.id));
          } else {
            marker.textContent = '×';
            marker.addEventListener('click', () => { rangeEditor.setRange(range); locateAudioRange(range); });
          }
          parent.appendChild(marker);
        }
      };
      const paragraphs = SubtitleBlocks.buildParagraphs({ words, asrBreaks, reviewSampleRate: sampleRate() });
      if (!paragraphs.length) {
        const empty = document.createElement('div');
        empty.className = 'paragraph-body'; addMarkers(null, empty); content.appendChild(empty);
      }
      paragraphs.forEach((paragraph, index) => {
        const row = document.createElement('div'); row.className = 'paragraph';
        const time = document.createElement('div'); time.className = 'tc';
        time.textContent = formatSample(paragraph.startSample);
        const body = document.createElement('div'); body.className = 'paragraph-body';
        if (index === 0) addMarkers(null, body);
        for (const word of paragraph.words) {
          const node = document.createElement('span'); node.className = 'word';
          node.dataset.wordId = word.id;
          node.dataset.startSample = word.startSample; node.dataset.endSample = word.endSample;
          node.textContent = word.text; body.appendChild(node); addMarkers(word.id, body);
        }
        row.append(time, body); content.appendChild(row);
      });
      refreshSelectionStyles();
    }

    function initRangeControls() {
      if (!usesRangeEditing()) return;
      document.getElementById('legacyCutControls').hidden = true;
      document.getElementById('silenceThreshold').hidden = true;
      const panel = document.getElementById('audioRangeEditor'); panel.hidden = false;
      document.getElementById('pauseInspector').hidden = false;
      rangeEditor = root.AudioRangeEditor.mount({ element: panel, sampleRate: sampleRate(), durationSamples: durationSamples(),
        getState: () => editState,
        getCurrentSample: () => playerSecondsToReviewSample(player.currentTime),
        addRange: range => dispatch({ type: 'ADD_MANUAL_DELETE_RANGE', range }),
        removeRange: id => dispatch({ type: 'REMOVE_MANUAL_DELETE_RANGE', id }),
        audition: range => { locateAudioRange(range); beginPreview(range, true); }, locate: locateAudioRange,
        onDraftChange: () => { if (compiledCutPlan) drawPlayhead(playerSecondsToReviewSample(player.currentTime)); },
      });
      if (editState.policy.version === 'narration-v1') {
        const suggestionPanel = document.getElementById('audioSuggestionEditor'); suggestionPanel.hidden = false;
        suggestionEditor = root.AudioSuggestionEditor.mount({element:suggestionPanel, suggestions:audioSuggestions,
          sampleRate:sampleRate(), durationSamples:durationSamples(), getState:() => editState, dispatch,
          locate:locateAudioRange, audition:range => { locateAudioRange(range); beginPreview(range, true); },
          editRange:item => {
            rangeEditor.setRange(item, { id:item.id, apply:range => dispatch({type:'SET_AUDIO_SUGGESTION_RANGE',range}) });
            panel.scrollIntoView({block:'nearest'});
          },
        });
      }
      document.getElementById('showShortPauses').addEventListener('change', event => {
        showShortPauses = event.target.checked; refreshSelectionStyles();
      });
      document.getElementById('auditionPause').addEventListener('click', () => {
        if (selectedPause) beginPreview({ startSample: selectedPause.startSample - sampleRate() / 2,
          endSample: selectedPause.endSample + sampleRate() / 2 }, true);
      });
      for (const [id, step] of [['previousPause', -1], ['nextPause', 1]]) {
        document.getElementById(id).addEventListener('click', () => {
          const groups = buildPauseGroups({ words, asrBreaks, detectedSilence }).filter(group => {
            const marker = [...content.querySelectorAll('.pause-marker')].find(node => node.dataset.pauseId === group.id);
            return marker && !marker.hidden;
          });
          if (!groups.length) return;
          const index = groups.findIndex(group => group.id === selectedPause?.id);
          focusPause(groups[(index < 0 ? (step > 0 ? 0 : groups.length - 1) : index + step + groups.length) % groups.length]);
        });
      }
      const help = document.querySelector('.help-row');
      if (help) help.lastElementChild.textContent = 'Shift 拖选波形 · I / O 起止 · Delete 删音';
      document.getElementById('lg-silence').parentElement.lastChild.textContent = '检测证据';
      document.getElementById('lg-cut').parentElement.lastChild.textContent = '实际删除';
    }

    function renderTranscript() {
      ensurePlanGapStyles();
      if (usesRangeEditing()) return renderReadableTranscript();
      content.replaceChildren();
      const paragraphs = SubtitleBlocks.buildParagraphs({
        words,
        asrBreaks,
        reviewSampleRate: sampleRate(),
      });
      const groupsByWord = new Map();
      for (const group of buildLegacyPauseGroups({ words, asrBreaks, detectedSilence })) {
        if (!groupsByWord.has(group.anchorWordId)) groupsByWord.set(group.anchorWordId, []);
        groupsByWord.get(group.anchorWordId).push(group);
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
        const paragraphGroups = [];
        if (!renderedLeading) {
          paragraphGroups.push(...(groupsByWord.get(null) || []));
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
          paragraphGroups.push(...(groupsByWord.get(word.id) || []));
        }
        const section = document.createElement('div');
        section.className = 'paragraph-content';
        section.appendChild(body);
        if (paragraphGroups.length) {
          const list = document.createElement('div');
          list.className = 'pause-list';
          const short = [];
          for (const group of paragraphGroups) {
            if (group.endSample - group.startSample >= Math.round(0.5 * sampleRate())) renderPause(group, list);
            else short.push(group);
          }
          if (short.length) {
            const more = document.createElement('details');
            more.className = 'short-pauses';
            const summary = document.createElement('summary');
            summary.textContent = `展开本段短停顿（${short.length}）`;
            more.appendChild(summary);
            short.forEach(group => renderPause(group, more));
            list.appendChild(more);
          }
          section.appendChild(list);
        }
        paragraphNode.append(timecode, section);
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
        if (usesRangeEditing()) {
          const coverage = gapCutCoverage(gapRange(node));
          node.dataset.audioCoverage = coverage;
          node.classList.toggle('audio-full', coverage === 'full');
          node.classList.toggle('audio-partial', coverage === 'partial');
          node.title = coverage === 'none' ? '原声保留；点击试听' : coverage === 'full'
            ? '此处音频已删除；点击试听原声' : '此处音频部分删除；点击试听原声，波形显示实际范围';
        }
      }
      if (usesRangeEditing()) {
        const suggestions = new Map(effectiveAudioSuggestions().map(item => [item.id, item]));
        for (const node of content.querySelectorAll('.audio-suggestion-marker')) {
          const item = suggestions.get(node.dataset.suggestionId);
          node.classList.toggle('restored', !item.enabled);
          node.textContent = item.enabled ? '×' : '·';
          node.title = `${item.enabled ? '自动删除' : '已恢复自动建议'} · ${formatSample(item.startSample)} · 点击调整`;
          node.setAttribute('aria-label', node.title);
        }
        for (const node of content.querySelectorAll('.pause-marker')) {
          const range = gapRange(node);
          const minimumSamples = Math.ceil(sampleRate() * DEFAULT_PAUSE_DISPLAY_MILLISECONDS / 1000);
          node.hidden = !showShortPauses && range.endSample - range.startSample < minimumSamples
            && gapCutCoverage(range) === 'none'
            && !editState.manualDeleteRanges.some(item => item.startSample < range.endSample && item.endSample > range.startSample);
        }
      }
      for (const node of content.querySelectorAll('[data-asr-break-id], [data-silence-id]')) {
        const range = gapRange(node);
        const manuallyDeleted = node.dataset.silenceId
          ? editState.manualDeleteRanges.some(item => item.sourceSilenceId === node.dataset.silenceId)
          : hasManualDeleteRange(range);
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
      for (const node of content.querySelectorAll('[data-pause-group]')) {
        const coverage = gapCutCoverage(gapRange(node));
        const status = node.querySelector('.pause-status');
        status.dataset.coverage = coverage;
        status.textContent = coverage === 'full' ? '已删除' : coverage === 'partial' ? '部分删除' : '保留';
      }
    }

    function toggleSilence(silenceId) {
      const item = detectedSilence.find(candidate => String(candidate.id) === String(silenceId));
      if (!item) throw new Error(`未知 detectedSilence: ${silenceId}`);
      const range = { startSample: item.startSample, endSample: item.endSample };
      const overlap = other => other.startSample < range.endSample && other.endSample > range.startSample;
      const ownMarks = editState.manualDeleteRanges.filter(mark => mark.sourceSilenceId === String(silenceId));
      const restoredRanges = editState.explicitlyRestoredSilenceRanges.filter(overlap);
      const removals = ownMarks.map(mark => ({type: 'REMOVE_MANUAL_DELETE_RANGE', range: mark, sourceSilenceId: mark.sourceSilenceId}));
      if (ownMarks.length || !isSilenceRestored(item) && gapCutCoverage(range) !== 'none') {
        return dispatchBatch([...removals, {type: 'RESTORE_SILENCE', silenceId, range, wasEffective: true}]);
      }
      if (isSilenceRestored(item)) {
        const actions = restoredRanges.map(mark => ({type: 'UNDO_RESTORE_SILENCE', silenceId: mark.silenceId, range: mark}));
        if (!actions.length) actions.push({type: 'UNDO_RESTORE_SILENCE', silenceId, range});
        // Re-enable only this PCM reason. With auto PCM off, the chip creates its own manual mark.
        if (editState.policy.autoSilenceEnabled === false) actions.push({type:'ADD_MANUAL_DELETE_RANGE', range, sourceSilenceId: String(silenceId)});
        return dispatchBatch(actions);
      }
      return dispatch({type: 'ADD_MANUAL_DELETE_RANGE', range, sourceSilenceId: String(silenceId)});
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
      if (!Number.isFinite(threshold)) { reportEditError(new Error('静音阈值必须是有限 dB 数值')); return null; }
      return dispatch({ type: 'SET_POLICY', patch: { silenceThresholdDb: threshold } });
    }

    function clearAll() {
      const restoredWords = [...new Set([...editState.explicitlyRestoredWordIds, ...editState.currentDeletedWordIds])].sort();
      return commitState(EditState.createEditState({
        ...editState, currentDeletedWordIds: [], manualDeleteRanges: [], explicitlyRestoredWordIds: restoredWords,
        ...(editState.policy.version === 'narration-v1' ? { audioSuggestionsEnabled:false } : {}),
        explicitlyRestoredSilenceIds: allDetectedSilence.map(item => String(item.id)),
        explicitlyRestoredSilenceRanges: allDetectedSilence.map(item => ({silenceId: String(item.id), startSample:item.startSample, endSample:item.endSample})),
      }));
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
      const draft = rangeEditor?.getDraft();
      if (draft) {
        const left = geometry.sampleToX(draft.startSample), right = geometry.sampleToX(draft.endSample);
        context.fillStyle = 'rgba(100,150,255,.22)';
        context.fillRect(left, 0, right - left, geometry.height);
        context.fillStyle = '#91baff';
        context.fillRect(left, 0, 2, geometry.height); context.fillRect(right - 2, 0, 2, geometry.height);
      }
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
      const pointerSample = event => {
        const rect = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(durationSamples(), Math.round(waveStartSample
          + (event.clientX - rect.left) / rect.width * (durationSamples() / waveScale))));
      };
      canvas.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, startSample: waveStartSample, moved: false,
          selection: Boolean(rangeEditor && event.shiftKey), anchor: pointerSample(event) };
        if (drag.selection) { player.pause(); event.preventDefault(); }
      });
      document.addEventListener('mousemove', event => {
        if (!drag) return;
        const delta = event.clientX - drag.x;
        if (Math.abs(delta) > 3) drag.moved = true;
        if (drag.selection) {
          const sample = pointerSample(event);
          rangeEditor.setRange({ startSample: Math.min(drag.anchor, sample), endSample: Math.max(drag.anchor, sample) });
          return;
        }
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

    function followTranscript(reviewSample, word, force) {
      if (!transcriptScroll || !words.length) return;
      // In a no-word range, reveal the nearest context without claiming a word is playing.
      let anchor = word;
      if (!anchor) {
        let distance = Infinity;
        for (const item of words) {
          const delta = Math.min(Math.abs(reviewSample - item.startSample), Math.abs(reviewSample - item.endSample));
          if (delta < distance) { anchor = item; distance = delta; }
        }
      }
      const element = currentWordElement || content.querySelector(`[data-word-id="${CSS.escape(anchor.id)}"]`);
      if (!element || (!force && element === followedWordElement)) return;
      followedWordElement = element;
      const viewport = transcriptScroll.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const margin = 16;
      // Scroll only this pane; do not move the waveform, focus, or media time.
      if (bounds.top < viewport.top + margin) transcriptScroll.scrollTop += bounds.top - viewport.top - margin;
      else if (bounds.bottom > viewport.bottom - margin) transcriptScroll.scrollTop += bounds.bottom - viewport.bottom + margin;
    }

    function updatePlayhead(reviewSample, forceFollow = false) {
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
      followTranscript(bounded, word, forceFollow);
      updateTitlePreview(bounded);
      if (viewportChanged) drawWave(bounded);
      else drawPlayhead(bounded);
    }

    function tick() {
      rafId = 0;
      if (document.hidden || api.error) { player.pause(); return; }
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
      if (!document.hidden && !rafId) rafId = root.requestAnimationFrame(tick);
    }

    async function exportNow() {
      if (!api.ready || !mediaCapabilityReady) throw new Error(mediaFailure || api.error || '浏览器媒体能力尚未验证');
      if (api.error || !compiledCutPlan) throw new Error(api.error || 'compiledCutPlan 尚未就绪');
      lastExportPayload = {
        compiledCutPlan,
        includeTitles: includeTitles.checked,
        editState: clone(editState),
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
        failure.permanent = false;
        throw failure;
      }
      if (!response.ok || !result.success) {
        const failure = new Error(result.error || `HTTP ${response.status}`);
        failure.permanent = result.permanent === true;
        throw failure;
      }
      if (typeof result.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(result.revision)
          || result.downloadUrl !== `/api/download/fcpxml/${result.revision}`) {
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
        const record = !pending.active;
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
        if (commitState(next, record)) { pending.active = true; suppressClick = true; }
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
        const cut = usesRangeEditing()
          ? compiledCutPlan.cuts.find(item => item.reviewStartSample < word.endSample && item.reviewEndSample > word.startSample)
          : cutAtSample(Math.round((word.startSample + word.endSample) / 2));
        if (cut) beginPreview({
          startSample: word.startSample,
          endSample: usesRangeEditing() ? Math.max(word.endSample, cut.reviewEndSample) : cut.reviewEndSample,
        }, true);
        else {
          seekReviewSample(word.startSample);
          player.play().catch(handlePlayError);
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
      player.loop = false;
      const pauseForBackground = () => {
        if (!document.hidden) return;
        player.pause();
        if (rafId) root.cancelAnimationFrame(rafId);
        rafId = 0;
        resetPlaybackState();
      };
      document.addEventListener('visibilitychange', pauseForBackground);
      root.addEventListener('pagehide', () => { player.pause(); resetPlaybackState(); });
      player.addEventListener('play', () => {
        if (document.hidden || api.error) { player.pause(); return; }
        processPlaybackSample(playerSecondsToReviewSample(player.currentTime));
        document.getElementById('playBtn').textContent = '❚❚ 暂停';
        startTick();
      });
      player.addEventListener('pause', () => {
        document.getElementById('playBtn').textContent = '▶ 播放';
        updatePlayhead(playerSecondsToReviewSample(player.currentTime || playerOffsetSeconds()));
      });
      player.addEventListener('seeking', () => { if (!pendingSeek) previousPlaybackSample = null; });
      player.addEventListener('seeked', () => {
        acknowledgePendingSeek();
        previousPlaybackSample = playerSecondsToReviewSample(player.currentTime);
        updatePlayhead(playerSecondsToReviewSample(player.currentTime), true);
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
        if (event.isComposing || event.altKey || event.target.isContentEditable) return;
        const textInput = event.target.tagName === 'TEXTAREA'
          || event.target.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(event.target.type);
        if (!event.metaKey && !event.ctrlKey) {
          const rangeAction = usesRangeEditing() && ({KeyI:'markRangeStart', KeyO:'markRangeEnd',
            Delete:'deleteRange', Backspace:'deleteRange'})[event.code];
          const deletingText = textInput && ['Delete', 'Backspace'].includes(event.code);
          if (event.code === 'Space' || rangeAction && !deletingText) {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) {
              if (event.code === 'Space') root.togglePlay();
              else document.getElementById(rangeAction).click();
            }
            return;
          }
        }
        if (textInput) return;
        if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ') {
          event.preventDefault();
          if (!event.repeat) { if (event.shiftKey) redo(); else undo(); }
        } else if ((event.metaKey || event.ctrlKey) && event.code === 'KeyY') {
          event.preventDefault(); if (!event.repeat) redo();
        } else if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT'
            || event.target.closest('.pause-list button, .pause-list summary, .range-body button, .range-body summary, .pause-marker, .range-marker')) {
          return;
        } else if (!event.metaKey && !event.ctrlKey && event.code === 'ArrowLeft') {
          event.preventDefault();
          root.seekRel(event.shiftKey ? -5 : -1);
        } else if (!event.metaKey && !event.ctrlKey && event.code === 'ArrowRight') {
          event.preventDefault();
          root.seekRel(event.shiftKey ? 5 : 1);
        }
      }, true);
      // A focused native button/checkbox must not also activate on Space keyup.
      document.addEventListener('keyup', event => {
        if (api.ready && mediaCapabilityReady && event.code === 'Space' && !event.isComposing
            && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.isContentEditable) {
          event.preventDefault(); event.stopPropagation();
        }
      }, true);
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
        audioSuggestions = data.audioSuggestions || [];
        seamPreparation = data.seamPreparation || null;
        if (seamPreparation) {
          if (!root.SeamPreparation) throw new Error('接缝复核模块未加载');
          root.SeamPreparation.validateFrozenPreparation(seamPreparation, words, data.initialSuggestedWordDeletes,
            data.mediaContext.review.decodedSampleCount, audioSuggestions);
        }
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
        editState = EditState.createInitialEditState({
          initialSuggestedWordDeletes: data.initialSuggestedWordDeletes,
          policy: {
            version: data.editPolicyVersion || 'legacy-v1',
            silenceThresholdDb: initialThreshold,
            minimumSilenceSamples: Math.round(0.2 * mediaContext.review.sampleRate),
            silencePaddingStartSamples:
              Math.round(startPaddingFrames / frameRate * mediaContext.review.sampleRate),
            silencePaddingEndSamples:
              Math.round(endPaddingFrames / frameRate * mediaContext.review.sampleRate),
          },
        }, data.restoredEditState, words);
        if (!data.silenceThresholds.map(Number).includes(editState.policy.silenceThresholdDb)) {
          throw new Error('恢复编辑的静音阈值与当前输入不一致');
        }
        detectedSilence = candidatesForThreshold(editState.policy.silenceThresholdDb);
        renderTranscript();
        initControls();
        initRangeControls();
        if (!refreshPlan()) return;
        timeTotal.textContent = formatSample(durationSamples());
        document.getElementById('fileSub').innerHTML = `REVIEW <span class="dot">●</span> ${editState.initialSuggestedWordDeletes.length} 处 AI 语言预选`;
        if (data.restoredEditState) document.getElementById('fileSub').append(' · 已恢复已导出编辑');
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
      if (player.paused) player.play().catch(handlePlayError);
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
      redo,
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
        previousPlaybackSample = null;
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

  return { mount, buildPauseGroups };
});
