'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const capability = require('../scripts/lib/review_media_capability');

// Only the HTMLMediaElement boundary is simulated here; browser decoding is
// covered separately with synthetic media served from localhost.
class MediaElement extends EventTarget {
  constructor(options = {}) {
    super();
    Object.assign(this, {
      readyState: 0, duration: NaN, videoWidth: 160, videoHeight: 90,
      paused: true, seeking: false, error: null, position: 0, seekHistory: [],
      supported: true, finishLoad: true, finishSeek: true,
    }, options);
  }

  canPlayType() { return this.supported ? 'probably' : ''; }
  pause() { this.paused = true; }
  load() {
    if (!this.finishLoad) return;
    queueMicrotask(() => {
      this.duration = 1.5;
      this.readyState = 3;
      this.dispatchEvent(new Event('canplay'));
    });
  }
  get currentTime() { return this.position; }
  set currentTime(value) {
    this.position = value;
    this.seekHistory.push(value);
    this.seeking = true;
    if (!this.finishSeek) return;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    });
  }
}

const audio = { mediaType: 'audio' };
const video = { mediaType: 'video', source: { audioCodec: 'aac', video: { codec: 'h264' } } };

test('capability requires decoded data and a completed seek in both directions', async () => {
  const media = new MediaElement();
  const result = await capability.probe(media, { mediaContext: video, timeoutMs: 100 });
  assert.equal(result.status, 'ready');
  assert.equal(result.mediaType, 'video');
  assert.equal(media.paused, true);
  assert.equal(media.currentTime, 0);
  assert.equal(media.seekHistory.length, 2);
  assert.ok(media.seekHistory[0] > 0);
  assert.equal(media.seekHistory[1], 0);
});

test('unknown video/audio codec combinations and browser-declared rejection fail closed', async () => {
  await assert.rejects(capability.probe(new MediaElement(), {
    mediaContext: { mediaType: 'video', source: { audioCodec: 'pcm_s16le', video: { codec: 'prores' } } },
  }), /编码.*prores.*pcm_s16le/);
  await assert.rejects(capability.probe(new MediaElement({ supported: false }), {
    mediaContext: audio,
  }), /浏览器.*不支持/);
});

test('audio metadata alone cannot pass capability and stalled loads have an actionable timeout', async () => {
  const media = new MediaElement({ finishLoad: false, readyState: 1, duration: 1.5 });
  await assert.rejects(capability.probe(media, { mediaContext: audio, timeoutMs: 15 }), /加载.*超时/);
  assert.equal(media.seekHistory.length, 0);
});

test('failed decode is reported immediately even before the probe subscribes', async () => {
  const media = new MediaElement({ error: { code: 3, message: 'DECODER_FAILED' } });
  await assert.rejects(capability.probe(media, { mediaContext: audio }), /解码失败/);
});

test('video must expose a decoded picture and a stalled seek fails closed', async () => {
  await assert.rejects(capability.probe(new MediaElement({ videoWidth: 0 }), {
    mediaContext: video, timeoutMs: 100,
  }), /视频画面/);
  await assert.rejects(capability.probe(new MediaElement({ finishSeek: false }), {
    mediaContext: audio, timeoutMs: 15,
  }), /定位.*超时/);
});

test('seek errors remain failures even if the player had previously loaded', async () => {
  const media = new MediaElement({ finishSeek: false });
  const pending = capability.probe(media, { mediaContext: audio, timeoutMs: 100 });
  setTimeout(() => {
    media.error = { code: 2 };
    media.dispatchEvent(new Event('error'));
  }, 5);
  await assert.rejects(pending, /媒体读取失败/);
});
