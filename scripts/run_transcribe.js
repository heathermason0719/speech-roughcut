#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { bindResult, claimInvocation, finishInvocation, suggestedBase } = require('./lib/invocation');

function parseArgs(args) {
  const positional = [];
  let engine = null;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-')) {
      if (!['--auto', '--flash', '--v3-standard'].includes(arg)) throw new Error(`未知参数: ${arg}`);
      if (engine) throw new Error('每次只能提供一个引擎参数');
      engine = arg.slice(2);
    } else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || positional.some(arg => !arg)) {
    throw new Error('用法: run_transcribe.sh <media_file> [base_output_dir] [--auto|--flash|--v3-standard]');
  }
  return { source: path.resolve(positional[0]), base: positional[1] && path.resolve(positional[1]), requestedEngine: engine || 'auto' };
}

async function main(args) {
  const options = parseArgs(args);
  if (!fs.statSync(options.source).isFile()) throw new Error('媒体路径必须是文件');
  for (const command of ['ffmpeg', 'ffprobe', 'node', 'python3', 'curl']) {
    const result = spawnSync('bash', ['-c', 'command -v "$1"', 'dependency-check', command], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`缺少依赖: ${command}`);
  }
  const skillDir = path.resolve(__dirname, '..');
  const toggle = path.join(skillDir, '.engine_toggle');
  const lastEngine = fs.existsSync(toggle) ? fs.readFileSync(toggle, 'utf8').trim() : '';
  const configured = spawnSync(process.execPath, [path.join(__dirname, 'select_transcribe_engine.js'),
    '--configured', options.requestedEngine, lastEngine, skillDir], { encoding: 'utf8' });
  if (configured.status !== 0) throw new Error(configured.stderr.trim() || '配置引擎选择失败');
  let engine = configured.stdout.trim();
  const claim = claimInvocation(options.base || suggestedBase(options.source), options.source);
  const dir = claim.record.transcribeDir;
  const env = { ...process.env, PYTHONUTF8: '1',
    SPEECH_ROUGHCUT_INVOCATION: claim.record.invocationId, SPEECH_ROUGHCUT_OWNER: claim.record.owner.token };
  let activeChild;
  let interrupted = false;
  const stop = () => { interrupted = true; if (activeChild) activeChild.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const run = (command, argv, capture = false) => new Promise((resolve, reject) => {
    if (interrupted) { reject(new Error('invocation 已中断')); return; }
    const child = spawn(command, argv, { env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    activeChild = child;
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      activeChild = null;
      if (code === 0 && !interrupted) resolve(output.trim());
      else reject(new Error(`invocation 阶段失败 (${signal || code})`));
    });
  });
  try {
    console.log(`INVOCATION_ID=${claim.record.invocationId}\nBASE_DIR=${path.dirname(dir)}`);
    console.log('📦 步骤1: 检查媒体...');
    const reviewAudio = await run(process.execPath, [path.join(__dirname, 'prepare_media.js'), claim.record.sourcePath, dir], true);
    const contextFile = path.join(dir, 'media_context.json');
    engine = await run(process.execPath, [path.join(__dirname, 'select_transcribe_engine.js'), options.requestedEngine, engine, contextFile, skillDir], true);
    console.log(`🚀 步骤2+3: 转录（引擎: ${engine}）...`);
    const providerScript = { flash: 'volcengine_flash_transcribe.sh', 'v3-standard': 'volcengine_v3_transcribe.sh' }[engine];
    if (!providerScript) throw new Error(`未知引擎: ${engine}`);
    await run('bash', [path.join(__dirname, providerScript), reviewAudio, dir]);
    bindResult(dir, env);
    console.log('📝 步骤4: 生成字幕...');
    await run(process.execPath, [path.join(__dirname, 'generate_subtitles.js'), path.join(dir, 'volcengine_v3_result.json'), contextFile, dir]);
    finishInvocation(claim, 'complete');
    if (options.requestedEngine === 'auto') fs.writeFileSync(toggle, `${engine}\n`);
    console.log(`🎉 流水线完成！\n   输出目录: ${dir}`);
  } catch (error) {
    finishInvocation(claim, 'failed');
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});
module.exports = { parseArgs };
