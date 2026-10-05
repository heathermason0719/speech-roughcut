#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { canonical, claimInvocation, resumeInvocation, setInvocationEngine, finishInvocation,
  suggestedBase, verifyContextIdentity, verifyTranscript } = require('./lib/invocation');
const { loadAndVerifyMediaContext } = require('./lib/media_manifest');
const { readProviderConfig, configError } = require('./lib/provider_config');
const { transcribeVolc, getCompletedRaw } = require('./lib/volc_task');
const { normalizeVolcResult } = require('./lib/volc_normalize');
const { publishTranscript } = require('./lib/transcript_publication');

function parseArgs(args) {
  const endOptions = args.indexOf('--');
  if (args.slice(0, endOptions < 0 ? args.length : endOptions).includes('--resume')) {
    if (args.length !== 2 || args[0] !== '--resume' || !args[1] || args[1].startsWith('-')) {
      throw new Error('用法: run_transcribe.sh --resume <BASE>；恢复不能同时指定媒体或引擎参数');
    }
    return { resume: true, base: path.resolve(args[1]) };
  }
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
  if (options.resume) {
    if (!fs.existsSync(path.join(options.base, 'invocation.json'))) throw new Error('resume 找不到 invocation.json');
  } else if (!fs.statSync(options.source).isFile()) throw new Error('媒体路径必须是文件');
  const base = canonical(options.base || process.env.SPEECH_ROUGHCUT_LOCKED_BASE || suggestedBase(options.source));
  if (process.env.SPEECH_ROUGHCUT_LOCKED_BASE !== base) {
    // The supervisor holds an OS lock across process death and ownership transfer.
    await new Promise((resolve, reject) => {
      const child = spawn('python3', [path.join(__dirname, 'lib/run_locked.py'), base, process.execPath, __filename, ...args], { stdio: 'inherit' });
      const stop = () => child.kill('SIGTERM');
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      child.once('error', reject);
      child.once('close', code => {
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        if (code === 0) resolve(); else reject(new Error(`转录入口退出 (${code})`));
      });
    });
    return;
  }
  for (const command of ['ffmpeg', 'ffprobe', 'node', 'python3', 'curl']) {
    const result = spawnSync('bash', ['-c', 'command -v "$1"', 'dependency-check', command], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`缺少依赖: ${command}`);
  }
  const skillDir = path.resolve(__dirname, '..');
  const toggle = path.join(skillDir, '.engine_toggle');
  const lastEngine = fs.existsSync(toggle) ? fs.readFileSync(toggle, 'utf8').trim() : '';
  let engine;
  if (!options.resume) {
    const configured = spawnSync(process.execPath, [path.join(__dirname, 'select_transcribe_engine.js'),
      '--configured', options.requestedEngine, lastEngine, skillDir], { encoding: 'utf8' });
    if (configured.status !== 0) throw new Error(configured.stderr.trim() || '配置引擎选择失败');
    engine = configured.stdout.trim();
  }
  if (options.resume) {
    const prior = JSON.parse(fs.readFileSync(path.join(base,'invocation.json'),'utf8'));
    if (prior.mode === 'offline-transcript-reuse' && prior.state !== 'complete') {
      throw new Error('离线复用失败不能恢复为 ASR 请求；请核验本地来源并使用新的复用 BASE');
    }
  }
  const claim = options.resume ? resumeInvocation(base) : claimInvocation(base, options.source);
  const dir = claim.record.transcribeDir;
  const env = { ...process.env, PYTHONUTF8: '1',
    SPEECH_ROUGHCUT_INVOCATION: claim.record.invocationId, SPEECH_ROUGHCUT_OWNER: claim.record.owner.token };
  let activeChild;
  let interrupted = false;
  const abort = new AbortController();
  const stop = () => { interrupted = true; abort.abort(); if (activeChild) activeChild.kill('SIGTERM'); };
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
    const contextFile = path.join(dir, 'media_context.json');
    if (!options.resume) {
      console.log('📦 步骤1: 检查媒体...');
      await run(process.execPath, [path.join(__dirname, 'prepare_media.js'), claim.record.sourcePath, dir], true);
      engine = await run(process.execPath, [path.join(__dirname, 'select_transcribe_engine.js'), options.requestedEngine, engine, contextFile, skillDir], true);
      setInvocationEngine(claim, engine, options.requestedEngine);
    } else engine = claim.record.engine;
    const context = loadAndVerifyMediaContext(contextFile);
    verifyContextIdentity(contextFile, context);
    if (claim.record.state === 'complete' || fs.existsSync(path.join(dir, '.transcripts/current'))) {
      verifyTranscript(contextFile, context, path.join(dir, 'subtitles_words.json'), path.join(dir, 'asr_breaks.json'), { allowIncomplete: true });
      if (claim.record.state !== 'complete') finishInvocation(claim, 'complete');
      console.log(`✅ 已有完整转录，校验通过，无需请求服务: ${dir}`);
      return;
    }
    const task = { engine, audioPath: context.reviewAudioPath, workDir: path.join(dir, '.asr'),
      invocationId: claim.record.invocationId, reviewFingerprint: JSON.stringify(context.reviewFingerprint), signal: abort.signal };
    let rawPath = getCompletedRaw(task);
    if (!rawPath) {
      if (options.resume && !fs.existsSync(path.join(task.workDir, 'task.json'))) {
        throw new Error('该 invocation 没有可恢复的提交记录；请使用新 BASE 发起新运行');
      }
      const config = readProviderConfig({ skillDir });
      if (config.state !== 'ok') throw new Error(configError(config));
      console.log(`🚀 ${options.resume ? '恢复查询原任务' : '转录'}（引擎: ${engine}）...`);
      rawPath = await transcribeVolc({ ...task, apiKey: config.key });
    } else console.log('📝 已有合法 raw result，仅重放本地字幕处理...');
    if (interrupted) throw new Error('invocation 已中断');
    const transcript = normalizeVolcResult(JSON.parse(fs.readFileSync(rawPath, 'utf8')), context);
    publishTranscript({ dir, context, transcript, rawPath, credentials: env });
    finishInvocation(claim, 'complete');
    if (options.requestedEngine === 'auto') fs.writeFileSync(toggle, `${engine}\n`);
    console.log(`🎉 流水线完成！\n   输出目录: ${dir}`);
  } catch (error) {
    // Local failure never changes the provider's persisted remote task outcome.
    if (claim.record.state !== 'complete') finishInvocation(claim, interrupted ? 'interrupted' : 'failed');
    console.error(`恢复入口: run_transcribe.sh --resume ${JSON.stringify(base)}`);
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
