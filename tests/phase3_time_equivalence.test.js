'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeAudio, makeCfrVideo } = require('./helpers/media_fixtures');
const { captureSnapshot, assertSnapshotTimeEquivalent } = require('./helpers/phase1_equivalence');

const BASELINE_REVISION = 'e3e6cb8d93d42b37cefd8b6b25afb6c72f8c866e';

test('Phase 3 无冲突时间与 plan 保持，仅允许已验证的音频 carrier 结构与 Title 帧格', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase3-equivalence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.resolve(__dirname, '..');
  const baseline = path.join(root, 'baseline');
  fs.mkdirSync(baseline);
  const archive = execFileSync('git', ['archive', '--format=tar', BASELINE_REVISION], {
    cwd: project,
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', baseline], { input: archive });

  for (const kind of ['wav', 'cfr']) {
    await t.test(kind, async () => {
      const dir = path.join(root, kind);
      fs.mkdirSync(dir);
      const options = { duration: 3.2, markers: [0.1, 1.4, 2.8], markerDuration: 0.09 };
      const source = kind === 'wav'
        ? makeAudio(dir, 'wav', options)
        : makeCfrVideo(dir, 'mp4', options);
      const before = await captureSnapshot(baseline, source, path.join(dir, 'before'));
      const after = await captureSnapshot(project, source, path.join(dir, 'after'));

      assertSnapshotTimeEquivalent(after, before);
      t.diagnostic(`${kind}: Phase 2 media/ASR/PCM/plan exact; only rendered audio Title times may change`);
    });
  }
});
