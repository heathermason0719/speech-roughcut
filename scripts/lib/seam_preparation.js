(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeamPreparation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const overlaps = (a, b) => a.startSample < b.endSample && a.endSample > b.startSample;
  const nonempty = value => typeof value === 'string' && !!value.trim();
  const range = (item, duration) => Number.isSafeInteger(item.startSample) && Number.isSafeInteger(item.endSample)
    && item.startSample >= 0 && item.endSample <= duration && item.endSample > item.startSample;

  // Only authored decisions enter here. No PCM, duration threshold, or inferred edge.
  function prepareSeams(preparation, words, selectedIds, duration) {
    if (!preparation || preparation.version !== 1 || !Array.isArray(preparation.decisions)
        || !Array.isArray(preparation.initialDeletedWordIds) || !Array.isArray(selectedIds)
        || !Number.isSafeInteger(duration) || duration <= 0
        || new Set(preparation.initialDeletedWordIds).size !== preparation.initialDeletedWordIds.length
        || !sameIds(preparation.initialDeletedWordIds, selectedIds)) throw new Error('接缝准备的版本或初选绑定无效');
    const byId = new Map(); let end = 0;
    words.forEach((w, i) => {
      if (!w || !nonempty(w.id) || byId.has(w.id) || !range(w, duration) || w.startSample < end) throw new Error('接缝 words 身份或时间顺序无效');
      byId.set(w.id, i); end = w.endSample;
    });
    const selected = new Set(selectedIds), used = new Set(), ids = new Set(), suggestions = [], seams = [];
    for (const id of selected) if (!byId.has(id)) throw new Error('接缝初选引用未知 word');
    for (const d of preparation.decisions) {
      if (!d || !nonempty(d.id) || ids.has(d.id) || !nonempty(d.reason) || !nonempty(d.basis)
          || !['resolved', 'pending'].includes(d.status) || !['pending', 'heard'].includes(d.hearingStatus)
          || !Array.isArray(d.deletedWordIds) || !d.deletedWordIds.length || !Array.isArray(d.retainedSounds)) throw new Error('接缝决定缺少身份、依据或状态');
      ids.add(d.id);
      const indices = d.deletedWordIds.map(id => byId.get(id));
      const first = indices[0], last = indices[indices.length - 1];
      if (indices.some((i, n) => i === undefined || i !== first + n || !selected.has(d.deletedWordIds[n]) || used.has(d.deletedWordIds[n]))
          || first > 0 && selected.has(words[first - 1].id) || last + 1 < words.length && selected.has(words[last + 1].id)) throw new Error('接缝必须覆盖完整连续删词 run');
      d.deletedWordIds.forEach(id => used.add(id));
      const left = words[first - 1], right = words[last + 1];
      if (d.leftWordId !== (left ? left.id : null) || d.rightWordId !== (right ? right.id : null)) throw new Error('接缝保留锚点无效');
      const startSample = left ? left.endSample : 0, endSample = right ? right.startSample : duration;
      const deletedStart = words[first].startSample, deletedEnd = words[last].endSample;
      if (![d.keepLeftSamples, d.keepRightSamples].every(n => Number.isSafeInteger(n) && n >= 0)
          || startSample + d.keepLeftSamples > deletedStart || endSample - d.keepRightSamples < deletedEnd) throw new Error('接缝停顿边界无效；不能跨 word 或暗中修正');
      let soundEnd = -1;
      for (const sound of d.retainedSounds) {
        if (!sound || !range(sound, duration) || sound.startSample < startSample || sound.endSample > endSample
            || sound.startSample < soundEnd || !nonempty(sound.reason) || !['intentional', 'pending'].includes(sound.status)
            || words.some(w => overlaps(w, sound))) throw new Error('接缝独立保留声音范围、理由或状态无效');
        soundEnd = sound.endSample;
      }
      const generated = [];
      if (d.status === 'resolved') {
        for (const [side, from, to] of [['left', startSample + d.keepLeftSamples, deletedStart], ['right', deletedEnd, endSample - d.keepRightSamples]]) {
          let cursor = from, part = 0;
          const add = finish => {
            if (finish > cursor) generated.push({id:`seam-${d.id}-${side}-${part++}`,seamId:d.id,
              groupId:'prepared-retake-seam',groupLabel:'重录接缝',startSample:cursor,endSample:finish,reason:d.reason,basis:d.basis});
          };
          for (const sound of d.retainedSounds.filter(s => s.endSample > from && s.startSample < to)) {
            add(Math.max(from, sound.startSample)); cursor = Math.min(to, sound.endSample);
          }
          add(to);
        }
      }
      suggestions.push(...generated);
      seams.push({...d,startSample,endSample,deletedStartSample:deletedStart,deletedEndSample:deletedEnd,suggestionIds:generated.map(s=>s.id)});
    }
    return {suggestions,seams};
  }

  function validateFrozenPreparation(preparation, words, selectedIds, duration, suggestions) {
    const result = prepareSeams(preparation, words, selectedIds, duration);
    if (JSON.stringify(result.suggestions) !== JSON.stringify(suggestions.filter(s => s.seamId !== undefined))) throw new Error('冻结接缝决定与音频建议不一致');
    return result;
  }

  // Read-only audit of the exact compiler result, including islands of every length.
  function auditSeams({plan, words, editState, preparation, audioSuggestions = []}) {
    const seams = preparation ? validateFrozenPreparation(preparation, words, editState.initialSuggestedWordDeletes,
      plan.reviewDecodedSampleCount, audioSuggestions).seams : [];
    const deleted = new Set(editState.currentDeletedWordIds), initial = new Set(editState.initialSuggestedWordDeletes || []);
    const disabled = new Set(editState.disabledAudioSuggestionIds || []);
    const tolerance = Math.ceil(plan.reviewSampleRate / (plan.timebase.kind === 'audio-samples'
      ? plan.timebase.ticksPerSecond : plan.timebase.fpsNum / plan.timebase.fpsDen));
    const reviews = seams.map(s => {
      const changed = s.deletedWordIds.some(id => !deleted.has(id)) || [s.leftWordId,s.rightWordId].filter(Boolean).some(id => deleted.has(id))
        || s.suggestionIds.length > 0 && (editState.audioSuggestionsEnabled === false || audioSuggestions.some(item=>item.seamId===s.id && (editState.disabledAudioSuggestionGroups || []).includes(item.groupId))
          || s.suggestionIds.some(id => disabled.has(id) || (editState.audioSuggestionRanges || []).some(r=>r.id===id)))
        || (editState.manualDeleteRanges || []).some(r=>overlaps(r,s));
      return {id:s.id,startSample:s.startSample,endSample:s.endSample,status:changed?'user-edited':s.status,hearingStatus:s.hearingStatus,
        reason:s.reason,basis:s.basis,retainedSounds:s.retainedSounds,suggestionIds:s.suggestionIds};
    });
    const retained = new Set(plan.retainedWordIds);
    const fragments = plan.keeps.filter(k => plan.cuts.some(c=>c.sourceEndTick===k.sourceStartTick)
      && plan.cuts.some(c=>c.sourceStartTick===k.sourceEndTick)
      && !words.some(w=>retained.has(w.id) && w.startSample<k.reviewEndSample && w.endSample>k.reviewStartSample)).map(k=>{
      const interval = {startSample:k.reviewStartSample,endSample:k.reviewEndSample};
      const leftCut = plan.cuts.find(c=>c.sourceEndTick===k.sourceStartTick);
      const rightCut = plan.cuts.find(c=>c.sourceStartTick===k.sourceEndTick);
      const neighborhood = {startSample:leftCut.reviewStartSample,endSample:rightCut.reviewEndSample};
      const editSources = {
        wordIds:words.filter(w=>initial.has(w.id)!==deleted.has(w.id) && overlaps(w,neighborhood)).map(w=>w.id),
        audioSuggestionIds:audioSuggestions.filter(item=>{
          const override = (editState.audioSuggestionRanges || []).find(r=>r.id===item.id);
          const changed = override || editState.audioSuggestionsEnabled===false || disabled.has(item.id)
            || (editState.disabledAudioSuggestionGroups || []).includes(item.groupId);
          return changed && (overlaps(item,neighborhood) || override && overlaps(override,neighborhood));
        }).map(item=>item.id),
        manualRangeIds:(editState.manualDeleteRanges || []).filter(r=>overlaps(r,neighborhood)).map(r=>r.id),
      };
      const related = reviews.filter(s=>overlaps(s,interval));
      const declaration = related.flatMap(s=>s.retainedSounds.map(sound=>({...sound,seamId:s.id}))).find(s=>s.startSample<=interval.startSample+tolerance && s.endSample>=interval.endSample-tolerance);
      const edited = Object.values(editSources).some(ids=>ids.length > 0);
      const status = related.some(s=>s.status==='user-edited') || edited ? 'user-edited'
        : declaration ? declaration.status : related.some(s=>s.status==='pending') ? 'pending'
          : related.some(s=>s.status==='resolved') ? 'preparation-failed' : 'pending';
      return {keepId:k.id,...interval,sourceStartTick:k.sourceStartTick,sourceEndTick:k.sourceEndTick,status,
        seamIds:related.map(s=>s.id),editSources,reason:declaration?.reason || (status==='user-edited'?'编辑改变了接缝，请复核':'无保留词覆盖的独立片段，请听审')};
    });
    return {fragments,seamReviews:reviews,preparationFailures:fragments.filter(f=>f.status==='preparation-failed')};
  }
  return {prepareSeams,validateFrozenPreparation,auditSeams};
});
