#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { canonical, writerForDir } = require('./lib/invocation');
const { atomicWrite } = require('./lib/atomic_file');
const { readProviderConfig, configError } = require('./lib/provider_config');
const { transcribeVolc, getCompletedRaw } = require('./lib/volc_task');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function parseArgs(args) {
  const [engine, ...rest] = args;
  if (!['flash', 'v3-standard'].includes(engine)) throw new Error('未知 provider 引擎');
  const positional = [];
  let resume = false;
  let options = true;
  for (const arg of rest) {
    if (options && arg === '--') { options = false; continue; }
    if (options && arg === '--resume') {
      if (resume) throw new Error('--resume 不能重复');
      resume = true;
    } else if (options && arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || positional.some(arg => !arg)) throw new Error('用法: volcengine_*_transcribe.sh <local_file_or_url> [output_dir] [--resume]');
  const isUrl = /^https?:\/\//.test(positional[0]);
  if (isUrl) new URL(positional[0]);
  return { engine, audioPath: isUrl ? positional[0] : canonical(positional[0]), outDir: canonical(positional[1] || '.'), isUrl, resume };
}

function assertStandalone(outDir) {
  let owner;
  try { owner = writerForDir(outDir); }
  catch (error) { throw new Error(`${error.message}；正式 BASE 请使用 run_transcribe.sh --resume BASE`); }
  if (owner) throw new Error('provider 工具不能修改正式 BASE；请使用 run_transcribe.sh --resume BASE');
}

async function withLock(options, args) {
  if (process.env.SPEECH_ROUGHCUT_LOCKED_BASE === options.outDir) return false;
  await new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(__dirname, 'lib/run_locked.py'), options.outDir, process.execPath, __filename, ...args], { stdio: 'inherit' });
    let interrupted = false;
    const stop = () => { interrupted = true; child.kill('SIGTERM'); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    child.on('error', reject);
    child.on('close', code => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      if (code === 0 && !interrupted) resolve();
      else reject(new Error('provider 转录未完成'));
    });
  });
  return true;
}

function publish(rawPath, resultPath) {
  const bytes = fs.readFileSync(rawPath);
  if (fs.existsSync(resultPath)) {
    if (!fs.readFileSync(resultPath).equals(bytes)) throw new Error('已有 provider 正式结果与验证后的 raw 不匹配，拒绝覆盖');
    return;
  }
  const temporary = `${resultPath}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // link publishes the complete file atomically and refuses an existing target.
    fs.linkSync(temporary, resultPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

async function main(args) {
  const options = parseArgs(args);
  assertStandalone(options.outDir);
  if (await withLock(options, args)) return;
  assertStandalone(options.outDir);
  const workDir = path.join(options.outDir, '.asr');
  const recordPath = path.join(workDir, 'standalone.json');
  const taskPath = path.join(workDir, 'task.json');
  const resultPath = path.join(options.outDir, 'volcengine_v3_result.json');
  const occupied = [recordPath, taskPath, resultPath, path.join(workDir, 'raw_result.json')].some(file => fs.existsSync(file));
  if (!options.resume && occupied) throw new Error('输出目录已有 checkpoint 或结果；请显式使用 --resume，或选择新的输出目录');
  if (options.resume && !fs.existsSync(recordPath)) throw new Error('缺少 standalone checkpoint，不能恢复或覆盖已有结果');
  let inputFingerprint;
  if (options.isUrl) inputFingerprint = `url:${options.audioPath}`;
  else {
    const stat = fs.statSync(options.audioPath);
    if (!stat.isFile()) throw new Error('音频路径必须是文件');
    if (options.engine === 'flash' && stat.size > 104857600) throw new Error('极速版音频超过 100MB，请使用标准版');
    inputFingerprint = `sha256:${hash(fs.readFileSync(options.audioPath))}`;
  }
  const identity = { engine: options.engine, audioPath: options.audioPath, outDir: options.outDir, inputFingerprint };
  let record;
  if (options.resume) {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (record.schemaVersion !== 1 || typeof record.invocationId !== 'string' || !record.invocationId) throw new Error('无效 standalone checkpoint');
    for (const [key, value] of Object.entries(identity)) if (record[key] !== value) throw new Error(`standalone 恢复身份不匹配: ${key}`);
  } else {
    fs.mkdirSync(workDir, { recursive: true });
    record = { schemaVersion: 1, invocationId: crypto.randomUUID(), ...identity };
    atomicWrite(recordPath, JSON.stringify(record, null, 2) + '\n');
  }
  const taskOptions = { engine: options.engine, audioPath: options.audioPath, workDir, invocationId: record.invocationId, reviewFingerprint: JSON.stringify(identity) };
  let rawPath = getCompletedRaw(taskOptions);
  if (fs.existsSync(resultPath) && !rawPath) throw new Error('已有 provider 正式结果但缺少可验证 raw，拒绝覆盖或网络重试');
  if (!rawPath) {
    const config = readProviderConfig({ skillDir: path.resolve(__dirname, '..') });
    if (config.state !== 'ok') throw new Error(configError(config));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    try { rawPath = await transcribeVolc({ ...taskOptions, apiKey: config.key, signal: controller.signal }); }
    finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  }
  publish(rawPath, resultPath);
  console.log(`✅ 转录结果已验证: ${resultPath}`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(`❌ ${error.message}`); process.exitCode = 1; });
module.exports = { main, parseArgs };
