'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeCfrVideo, writeMonoWav } = require('./helpers/media_fixtures');
const { captureSnapshot, assertSnapshotTimeEquivalent } = require('./helpers/phase1_equivalence');

// Capture both revisions with one ffmpeg installation and the exact same source
// bytes. A pinned Git archive prevents working-tree edits from changing the oracle.
const BASELINE_REVISION = '94db7762a1cd5c17d5ff827989c5f2fd313f5abd';
const repositoryRoot = path.resolve(__dirname, '..');

test('Phase 1 基线时间与 plan 保持，仅允许已验证的音频 carrier 结构与 Title 帧格', async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase1-equivalence-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const baselineRoot = path.join(temporaryRoot, 'baseline');
  fs.mkdirSync(baselineRoot);
  const archive = execFileSync('git', ['archive', '--format=tar', BASELINE_REVISION], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });

  for (const kind of ['wav', 'cfr']) {
    await t.test(kind, async () => {
      const mediaRoot = path.join(temporaryRoot, kind);
      fs.mkdirSync(mediaRoot);
      const options = { duration: 3.2, markers: [0.1, 1.4, 2.8], markerDuration: 0.09 };
      const source = kind === 'cfr'
        ? makeCfrVideo(mediaRoot, 'mp4', options)
        : writeMonoWav(path.join(mediaRoot, 'source.wav'), {
          duration: options.duration,
          // Exercise conversion between a 44.1 kHz source and 48 kHz review clock.
          sampleRate: 44100,
          sampleAt(_index, time) {
            const markerIndex = options.markers.findIndex(marker => (
              time >= marker && time < marker + options.markerDuration
            ));
            if (markerIndex < 0) return 0;
            return 0.85 * Math.sin(2 * Math.PI * (800 + markerIndex * 400)
              * (time - options.markers[markerIndex]));
          },
        });
      const sourceBefore = fs.readFileSync(source);
      const baseline = await captureSnapshot(baselineRoot, source, path.join(mediaRoot, 'before'));
      const current = await captureSnapshot(repositoryRoot, source, path.join(mediaRoot, 'after'));
      assert.deepEqual(fs.readFileSync(source), sourceBefore, '两次运行不得修改共同的原始媒体');
      assertSnapshotTimeEquivalent(current, baseline);
      t.diagnostic(`${kind}: media/ASR/PCM/plan exact; audio sample times exact across carrier rebasing; accepted carrier tail and Title frame grid only`);
    });
  }
});
