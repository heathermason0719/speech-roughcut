'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const SUCCESS = '20000000';
const PENDING = new Set(['20000001', '20000002']);
const STATES = new Set(['intent', 'accepted', 'uncertain', 'pending', 'terminal_failure', 'raw_ready', 'complete']);
const endpoint = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUrl = value => /^https?:\/\//.test(value);

function atomicWrite(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function identity(options) {
  const { engine, audioPath, workDir, invocationId, reviewFingerprint } = options;
  if (!['v3-standard', 'flash'].includes(engine)) throw new Error('Unsupported Volc engine');
  for (const [key, value] of Object.entries({ audioPath, workDir, invocationId, reviewFingerprint })) {
    if (typeof value !== 'string' || !value) throw new Error(`Missing Volc ${key}`);
  }
  return { engine, audioPath: isUrl(audioPath) ? audioPath : path.resolve(audioPath), invocationId, reviewFingerprint };
}

function readTask(options) {
  const owner = identity(options);
  const taskPath = path.join(options.workDir, 'task.json');
  let task;
  try { task = JSON.parse(fs.readFileSync(taskPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Invalid Volc task checkpoint: ${error.message}`);
  }
  if (!object(task) || task.schemaVersion !== 1 || !STATES.has(task.status) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(task.requestId)) throw new Error('Invalid Volc task checkpoint');
  for (const [key, value] of Object.entries(owner)) {
    if (task[key] !== value) throw new Error(`Volc task ownership mismatch: ${key}`);
  }
  if (task.logId != null && (typeof task.logId !== 'string' || /[\r\n]/.test(task.logId))) throw new Error('Invalid Volc task log ID');
  return task;
}

function rawBody(bytes) {
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid or truncated Volc response JSON'); }
  // Timestamp and word suitability are checked by canonical normalization later.
  if (!object(body) || !object(body.result)) throw new Error('Invalid Volc result body');
  return body;
}

function completedRaw(options, task) {
  const rawPath = path.join(options.workDir, 'raw_result.json');
  let bytes;
  try { bytes = fs.readFileSync(rawPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!task || !['raw_ready', 'complete'].includes(task.status) || !task.rawSha256) throw new Error('Volc raw result has no verified task ownership');
  if (digest(bytes) !== task.rawSha256 || bytes.length !== task.rawBytes) throw new Error('Volc raw result digest mismatch');
  rawBody(bytes);
  return rawPath;
}

function getCompletedRaw(options) {
  return completedRaw(options, readTask(options));
}

function abortError() {
  const error = new Error('Volc request aborted; remote outcome may be uncertain');
  error.name = 'AbortError';
  return error;
}

async function curlRequest({ options, task, kind, body }) {
  if (options.signal?.aborted) throw abortError();
  const tempDir = fs.mkdtempSync(path.join(options.workDir, '.volc-'));
  try {
    const requestPath = path.join(tempDir, 'request.json');
    const headersPath = path.join(tempDir, 'headers');
    const bodyPath = path.join(tempDir, 'body');
    fs.writeFileSync(requestPath, body, { mode: 0o600 });
    const args = ['-sS', '--max-time', String(options.requestTimeoutSeconds), '-D', headersPath, '-o', bodyPath, '-w', '%{http_code}', '-X', 'POST', `${endpoint}/${kind}`, '-H', `X-Api-Key: ${options.apiKey}`, '-H', `X-Api-Resource-Id: ${task.engine === 'flash' ? 'volc.bigasr.auc_turbo' : 'volc.bigasr.auc'}`, '-H', `X-Api-Request-Id: ${task.requestId}`, '-H', 'Content-Type: application/json'];
    if (kind === 'query' && task.logId) args.push('-H', `X-Tt-Logid: ${task.logId}`);
    if (kind !== 'query') args.push('-H', 'X-Api-Sequence: -1');
    args.push('--data-binary', `@${requestPath}`);
    const execution = await new Promise((resolve, reject) => {
      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
      let output = '';
      let spawnError;
      let killTimer;
      const kill = signal => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) { if (error.code !== 'ESRCH') spawnError = error; }
      };
      const onAbort = () => {
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 250);
      };
      child.stdout.on('data', data => { output = (output + data.toString()).slice(-1024); });
      child.on('error', error => { spawnError = error; });
      child.on('close', code => {
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
        // No shell is involved. Also stop descendants in the curl process group before cleanup.
        if (options.signal?.aborted) { kill('SIGKILL'); reject(abortError()); }
        else if (spawnError) reject(new Error(`Volc curl failed: ${spawnError.code || 'spawn error'}; outcome uncertain`));
        else resolve({ code, http: output.trim() });
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    let headers = {};
    const headerText = fs.existsSync(headersPath) ? fs.readFileSync(headersPath, 'utf8') : '';
    for (const line of headerText.split(/\r?\n/)) {
      if (/^HTTP\//i.test(line)) headers = {};
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { ...execution, headers, bytes: fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath) : Buffer.alloc(0) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildRequest(audioPath) {
  const audio = isUrl(audioPath)
    ? { url: audioPath, format: path.extname(new URL(audioPath).pathname).slice(1).toLowerCase() || 'mp3' }
    : { format: path.extname(audioPath).slice(1).toLowerCase() || 'mp3', data: fs.readFileSync(audioPath).toString('base64') };
  return JSON.stringify({ user: { uid: 'ai_jiankoubo' }, audio, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: false, enable_ddc: false, show_utterances: true, enable_speaker_info: false } });
}

async function transcribeVolc(input) {
  const options = { pollIntervalMs: 5000, maxAttempts: 120, requestTimeoutSeconds: 60, ...input };
  const owner = identity(options);
  let task = readTask(options);
  const existing = completedRaw(options, task);
  if (existing) return existing;
  if (task?.status === 'complete') throw new Error('Completed Volc raw result is missing; refusing to submit again');
  if (task?.status === 'terminal_failure') throw new Error(`Volc provider terminal failure (${task.providerStatus}); refusing to submit again`);
  if (task && owner.engine === 'flash') throw new Error('Flash outcome uncertain and cannot be queried; a new invocation requires the user’s decision');
  if (options.signal?.aborted) throw abortError();
  if (typeof options.apiKey !== 'string' || !options.apiKey || /[\r\n]/.test(options.apiKey)) throw new Error('Volc API key required for network request');
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || !Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0 || !Number.isFinite(options.requestTimeoutSeconds) || options.requestTimeoutSeconds <= 0) throw new Error('Invalid Volc polling or timeout options');
  fs.mkdirSync(options.workDir, { recursive: true });
  const save = changes => {
    const next = { ...task, ...changes, updatedAt: new Date().toISOString() };
    atomicWrite(path.join(options.workDir, 'task.json'), JSON.stringify(next, null, 2) + '\n');
    task = next;
  };
  const request = async (kind, body) => {
    let response;
    try { response = await curlRequest({ options, task, kind, body }); }
    catch (error) {
      save({ status: 'uncertain', lastOperation: kind });
      throw error;
    }
    const logId = response.headers['x-tt-logid'];
    if (logId && !task.logId) save({ logId });
    if (response.code !== 0 || !/^2\d\d$/.test(response.http)) {
      save({ status: 'uncertain', lastOperation: kind, lastHttpStatus: response.http });
      throw new Error(`Volc ${kind} outcome uncertain (curl ${response.code}, HTTP ${response.http}); resume this invocation to query the existing task`);
    }
    const status = response.headers['x-api-status-code'];
    if (!/^\d{8}$/.test(status || '')) {
      save({ status: 'uncertain', lastOperation: kind });
      throw new Error(`Invalid Volc business status; ${kind} outcome uncertain`);
    }
    if (status && status !== SUCCESS && !PENDING.has(status)) {
      save({ status: 'terminal_failure', providerStatus: status, lastOperation: kind });
      throw new Error(`Volc provider terminal failure (${status}); refusing to submit again`);
    }
    let parsed;
    try { parsed = JSON.parse(response.bytes.toString('utf8')); }
    catch {
      save({ status: 'uncertain', lastOperation: kind });
      throw new Error(`Invalid or truncated Volc JSON; ${kind} outcome uncertain`);
    }
    if (!object(parsed) || !status) {
      save({ status: 'uncertain', lastOperation: kind });
      throw new Error(`Invalid Volc response; ${kind} outcome uncertain`);
    }
    return { ...response, status };
  };
  const publish = response => {
    rawBody(response.bytes);
    // Record the successful digest before publishing bytes. A crash after rename
    // can replay the raw without sending another network request.
    save({ status: 'raw_ready', rawSha256: digest(response.bytes), rawBytes: response.bytes.length, providerStatus: SUCCESS });
    const rawPath = path.join(options.workDir, 'raw_result.json');
    atomicWrite(rawPath, response.bytes);
    save({ status: 'complete' });
    return rawPath;
  };
  if (!task) {
    const body = buildRequest(owner.audioPath);
    task = { schemaVersion: 1, ...owner, requestId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    save({ status: 'intent' });
    const response = await request(owner.engine === 'flash' ? 'recognize/flash' : 'submit', body);
    if (owner.engine === 'flash') {
      if (response.status !== SUCCESS) throw new Error('Flash outcome uncertain; no completed response was returned');
      return publish(response);
    }
    save({ status: 'accepted', providerStatus: response.status });
  }
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    if (options.pollIntervalMs) await delay(options.pollIntervalMs, undefined, { signal: options.signal });
    const response = await request('query', '{}');
    if (response.status === SUCCESS) return publish(response);
    save({ status: 'pending', providerStatus: response.status });
  }
  throw new Error('Volc polling limit reached; remote task is pending. Resume this invocation to query it without resubmission');
}

module.exports = { transcribeVolc, getCompletedRaw };
