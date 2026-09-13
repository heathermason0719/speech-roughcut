'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeAudio, makeCfrVideo } = require('./helpers/media_fixtures');
const { captureSnapshot } = require('./helpers/phase1_equivalence');

test('Phase 2 与已验收 Phase 1 HEAD 的 WAV/CFR 时间、PCM、plan、Title、FCPXML 数字完全一致', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-phase2-equivalence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.resolve(__dirname, '..');
  const baseline = path.join(root, 'baseline');
  fs.mkdirSync(baseline);
  const archive = execFileSync('git', ['archive', '--format=tar', '45495ef37c8b9c0af0178b0c151941a9b6c3e165'], { cwd: project, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', baseline], { input: archive });
  for (const kind of ['wav', 'cfr']) {
    await t.test(kind, async () => {
      const dir = path.join(root, kind); fs.mkdirSync(dir);
      const options = { duration: 3.2, markers: [0.1, 1.4, 2.8], markerDuration: 0.09 };
      const source = kind === 'wav' ? makeAudio(dir, 'wav', options) : makeCfrVideo(dir, 'mp4', options);
      const before = await captureSnapshot(baseline, source, path.join(dir, 'before'));
      const after = await captureSnapshot(project, source, path.join(dir, 'after'));
      assert.deepEqual(after, before);
      t.diagnostic(`${kind}: four edit states and eight FCPXML exports exactly equal to Phase 1`);
    });
  }
});
