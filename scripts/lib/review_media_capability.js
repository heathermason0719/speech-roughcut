(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewMediaCapability = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function describeError(player) {
    const code = Number(player.error && player.error.code);
    const reasons = {
      1: '媒体加载已中止，请重新打开审核页',
      2: '媒体读取失败，请确认本地审核服务和原始文件可用',
      3: '浏览器媒体解码失败，请使用兼容的浏览器或重新准备兼容素材',
      4: '浏览器不支持此媒体格式或编码，请使用兼容的浏览器或重新准备兼容素材',
    };
    return new Error(reasons[code] || '浏览器媒体不可用，无法继续审核');
  }

  function contentType(mediaContext) {
    if (mediaContext.mediaType === 'audio') return 'audio/mpeg';
    if (mediaContext.mediaType !== 'video') throw new Error('审核媒体类型无效');
    const source = mediaContext.source || {};
    const videoCodec = source.video && source.video.codec;
    // This is a conservative admission query, not a claim that every MP4/MOV
    // codec can play. Unknown combinations must not silently lose an AV track.
    if (videoCodec !== 'h264' || source.audioCodec !== 'aac') {
      throw new Error(`无法确认浏览器审核编码: ${videoCodec || '未知视频'} / ${source.audioCodec || '未知音频'}；当前入口仅验证 H.264 / AAC 视频`);
    }
    return 'video/mp4; codecs="avc1, mp4a.40.2"';
  }

  function waitFor(player, { events, ready, start, timeoutMs, label }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        for (const name of events) player.removeEventListener(name, check);
        player.removeEventListener('error', check);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (player.error) finish(describeError(player));
        else if (ready()) finish();
      };
      for (const name of events) player.addEventListener(name, check);
      player.addEventListener('error', check);
      timer = setTimeout(() => finish(new Error(`浏览器媒体${label}超时，请确认本地审核服务可用后重新打开审核页`)), timeoutMs);
      if (player.error) { check(); return; }
      try {
        if (start) start();
        check();
      } catch (error) {
        finish(error);
      }
    });
  }

  async function probe(player, { mediaContext, timeoutMs = 15000 }) {
    const type = contentType(mediaContext);
    if (!player || typeof player.canPlayType !== 'function' || !player.canPlayType(type)) {
      throw new Error(`当前浏览器不支持审核媒体 (${type})，请使用兼容的浏览器`);
    }
    if (player.error) throw describeError(player);
    player.pause();
    player.preload = 'auto';
    await waitFor(player, {
      events: ['loadeddata', 'canplay', 'progress'],
      ready: () => player.readyState >= 3,
      start: () => { if (player.readyState < 3) player.load(); },
      timeoutMs,
      label: '加载',
    });
    if (!Number.isFinite(player.duration) || !(player.duration > 0)) {
      throw new Error('浏览器未能读取有效媒体时长，无法继续审核');
    }
    if (mediaContext.mediaType === 'video' && (!(player.videoWidth > 0) || !(player.videoHeight > 0))) {
      throw new Error('浏览器未能解码视频画面，无法继续审核');
    }
    const originalTime = player.currentTime;
    const target = originalTime < player.duration / 2 ? player.duration * 0.75 : player.duration * 0.25;
    for (const position of [target, originalTime]) {
      await waitFor(player, {
        events: ['seeked', 'canplay'],
        ready: () => !player.seeking && player.readyState >= 2
          && Math.abs(player.currentTime - position) <= 0.05,
        start: () => { player.currentTime = position; },
        timeoutMs,
        label: '定位',
      });
    }
    // This only admits browser decoding/seeking. It does not calibrate clocks,
    // establish A/V alignment, or replace the existing media time contract.
    return { status: 'ready', mediaType: mediaContext.mediaType };
  }

  return { probe, describeError };
});
