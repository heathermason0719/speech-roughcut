'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serveScript = path.resolve(__dirname, '../scripts/serve_review.sh');

test('审核 launcher 对目录和媒体参数使用 shell-safe argv 序列化', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-roughcut-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reviewDir = path.join(root, 'review "$(touch SHOULD_NOT_EXIST)" $HOME');
  fs.mkdirSync(reviewDir);
  const context = path.join(root, 'context `touch ALSO_NOT` $.json');
  const server = path.join(root, 'server "quoted".js');
  fs.writeFileSync(context, '{}');
  fs.writeFileSync(server, '');
  const output = execFileSync('bash', [serveScript, reviewDir, context, server, '8899'], {
    env: { ...process.env, SERVE_REVIEW_NO_SPAWN: '1' },
    encoding: 'utf8',
  });
  const launcherName = process.platform === 'darwin' ? '启动审核服务.command' : '启动审核服务.sh';
  const launcher = fs.readFileSync(path.join(reviewDir, launcherName), 'utf8');
  assert.doesNotMatch(launcher, /cd "[^"]*\$\(/);
  assert.doesNotMatch(launcher, /exec "[^"]*`/);
  assert.match(launcher, /review\\ \\"\\\$\\\(touch\\ SHOULD_NOT_EXIST\\\)\\"\\ \\\$HOME/);
  assert.match(launcher, /context\\ \\`touch\\ ALSO_NOT\\`\\ \\\$\.json/);
  const fallback = output.split(/\r?\n/).find(line => line.trimStart().startsWith('bash '));
  assert.match(fallback, /^\s+bash /);
  execFileSync('bash', ['-c', fallback.trim()], {
    cwd: root,
    env: { ...process.env, HOME: path.join(root, 'expanded-home') },
  });
  assert.equal(fs.existsSync(path.join(root, 'SHOULD_NOT_EXIST')), false);
  assert.equal(fs.existsSync(path.join(root, 'ALSO_NOT')), false);
});
