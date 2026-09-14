'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { writeMonoWav, encodeAudio } = require('./helpers/media_fixtures');
const { compileEdit } = require('../scripts/lib/compile_edit');
const { createEditState } = require('../scripts/lib/edit_state');
const { buildFcpxml } = require('../scripts/lib/fcpxml');

// Acoustic evidence uses independent full decodes, never packet duration as PCM.
function decode(file, rate = 48000) {
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0',
    '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function correlate(source, review, second, radius = 480) {
  const start = Math.round(second * 48000);
  let best = { lag: 0, correlation: -Infinity };
  for (let lag = -radius; lag <= radius; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = start; i < start + 4800; i += 2) {
      const x = source[i], y = review[i + lag];
      xy += x * y; xx += x * x; yy += y * y;
    }
    const correlation = xy / Math.sqrt(xx * yy);
    if (correlation > best.correlation) best = { lag, correlation };
  }
  return best;
}

function prepare(source, directory) {
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/prepare_media.js'), source, directory]);
  return JSON.parse(fs.readFileSync(path.join(directory, 'media_context.json'), 'utf8'));
}

test('Phase 4 声学测量能区分已知固定偏移和逐点增长的偏移', () => {
  const source = new Float32Array(3 * 48000);
  let seed = 9;
  for (let i = 0; i < source.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    source[i] = seed / 4294967296 - 0.5;
  }
  const markers = [0.2, 1.2, 2.2];
  for (const lags of [[137, 137, 137], [0, 24, 48]]) {
    const shifted = new Float32Array(source.length);
    markers.forEach((second, index) => {
      const start = Math.round(second * 48000);
      shifted.set(source.subarray(start, start + 4800), start + lags[index]);
    });
    assert.deepEqual(markers.map(second => correlate(source, shifted, second).lag), lags);
  }
});

test('Phase 4 source/review 三点声学与有效 sample count：代表格式及高采样率', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase4-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rate, extension] of [[44100, 'wav'], [44100, 'mp3'], [44100, 'm4a'],
    [48000, 'wav'], [96000, 'wav'], [192000, 'wav'], [384000, 'wav'], [48000, 'cfr']]) {
    await t.test(`${rate}/${extension}`, () => {
      const dir = path.join(root, `${rate}-${extension}`);
      fs.mkdirSync(dir);
      const markers = [0.2, 15.1, 29.5];
      const wav = writeMonoWav(path.join(dir, 'markers.wav'), {
        duration: 30.013, sampleRate: rate,
        sampleAt(_i, time) {
          const index = markers.findIndex(m => time >= m && time < m + 0.12);
          if (index < 0) return 0;
          const x = time - markers[index];
          return 0.7 * Math.sin(2 * Math.PI * (600 * x + 12000 * x * x));
        },
      });
      let source = wav;
      if (extension === 'cfr') {
        source = path.join(dir, 'source.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30000/1001:d=30.013',
          '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-fps_mode', 'cfr', '-c:a', 'aac', '-shortest', '-y', source]);
      } else if (extension !== 'wav') source = encodeAudio(wav, path.join(dir, `source.${extension}`));
      const context = prepare(source, path.join(dir, 'prepared'));
      const a = decode(source), b = decode(context.reviewAudioPath);
      assert.equal(a.length, context.source.normalizedDecodedSampleCount);
      assert.equal(b.length, context.review.decodedSampleCount);
      assert.equal(a.length, b.length);
      const residuals = markers.map(m => correlate(a, b, m));
      assert.ok(residuals.every(r => r.correlation > 0.97 && Math.abs(r.lag) <= 1), JSON.stringify(residuals));
      assert.ok(Math.max(...residuals.map(r => r.lag)) - Math.min(...residuals.map(r => r.lag)) <= 1);
      const nativeCount = decode(source, rate).length;
      assert.ok(Math.abs(a.length / 48000 - nativeCount / rate) <= 1 / 48000 + 1e-9);
      const plan = compileEdit({ mediaContext: context, editState: createEditState({ policy: { autoSilenceEnabled: false } }) });
      t.diagnostic(JSON.stringify({ rate, extension, nativeCount, reviewCount: b.length,
        packetEnd: context.source.audioPresentationEnd, sourceDurationTicks: plan.sourceDurationTicks,
        videoFrames: context.source.video?.frameCount, residuals }));
    });
  }
});

test('Phase 4 Title 网格误差与极短 keep/cut 的 review/source 可见性', () => {
  for (const timebase of [44100, 48000, 96000, 192000, 384000].map(ticksPerSecond => ({ kind: 'audio-samples', ticksPerSecond }))
    .concat([{ kind: 'video-frames', fpsNum: 30000, fpsDen: 1001 }])) {
    const rate = timebase.ticksPerSecond || timebase.fpsNum / timebase.fpsDen;
    const context = { sourcePath: '/tmp/phase4.wav', exportPath: '/tmp/phase4.wav', mediaType: timebase.kind === 'audio-samples' ? 'audio' : 'video',
      source: { sampleRate: 48000, channels: 1, rate: 1, presentationStart: 0,
        video: { isCfr: true, presentationStart: 0, fpsNum: 30000, fpsDen: 1001, width: 160, height: 90 } },
      review: { sampleRate: 48000, decodedSampleCount: 96000 }, timebase,
      offsets: { sourceMediaOffset: { seconds: 0, status: 'verified' } } };
    for (const width of [1, 2, 3, 47, 480, 1601, 1602]) {
      for (let start = 47980; start < 48020; start++) {
        for (const keepOnly of [false, true]) {
          const ranges = keepOnly ? [{ startSample: 0, endSample: start }, { startSample: start + width, endSample: 96000 }]
            : [{ startSample: start, endSample: start + width }];
          const words = [{ id: 'w', text: '边界', startSample: start - 2, endSample: start + width + 2 }];
          const plan = compileEdit({ words, mediaContext: context,
            editState: createEditState({ manualDeleteRanges: ranges, policy: { autoSilenceEnabled: false } }) });
          const all = [...plan.keeps, ...plan.cuts].sort((a, b) => a.sourceStartTick - b.sourceStartTick);
          assert.equal(all[0].reviewStartSample, 0);
          assert.equal(all.at(-1).reviewEndSample, 96000);
          for (let i = 0; i < all.length; i++) {
            assert.ok(all[i].reviewEndSample > all[i].reviewStartSample, JSON.stringify({ timebase, start, width, keepOnly, all }));
            if (i) assert.equal(all[i].reviewStartSample, all[i - 1].reviewEndSample);
          }
          for (const title of plan.titleBlocks) {
            const tolerance = 1 / rate + 0.5 / 48000 + 1e-9;
            assert.ok(Math.abs(title.sourceStartTick / rate - title.reviewStartSample / 48000) <= tolerance);
            assert.ok(Math.abs(title.sourceEndTick / rate - title.reviewEndSample / 48000) <= tolerance);
            const keep = plan.keeps[title.keepIndex];
            assert.equal(title.outputStartTick, keep.outputStartTick + title.sourceStartTick - keep.sourceStartTick);
          }
          // Sub-frame Title output has its own fail-closed/frame-grid tests;
          // this sweep checks that even one-sample AUDIO intervals survive.
          const xml = buildFcpxml({ mediaContext: context, compiledCutPlan: plan, includeTitles: false }).xml;
          assert.equal((xml.match(/<asset-clip /g) || []).length, plan.keeps.length);
          assert.equal((xml.match(/<title /g) || []).length, 0);
          if (timebase.kind === 'audio-samples') {
            const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
            const sample = text => {
              const [n, d = '1'] = text.slice(0, -1).split('/');
              const numerator = BigInt(n) * BigInt(rate);
              assert.equal(numerator % BigInt(d), 0n);
              return numerator / BigInt(d);
            };
            const carrier = attrs(xml.match(/<gap\b([^>]*)>/)[1]);
            const [cn, cd] = carrier.duration.slice(0, -1).split('/').map(BigInt);
            const total = BigInt(plan.keeps.at(-1)?.outputEndTick || 0);
            assert.ok(cn * BigInt(rate) >= total * cd);
            assert.ok((cn * BigInt(rate) - total * cd) * 30n < cd * BigInt(rate));
            [...xml.matchAll(/<asset-clip\b([^>]*)>/g)].forEach((match, i) => {
              const a = attrs(match[1]), k = plan.keeps[i];
              assert.equal(a.lane, '-1');
              assert.equal(sample(a.start), BigInt(k.sourceStartTick));
              assert.equal(sample(a.duration), BigInt(k.sourceEndTick - k.sourceStartTick));
              assert.equal(sample(a.offset) - sample(carrier.start), BigInt(k.outputStartTick));
            });
          }
        }
      }
    }
  }
});
