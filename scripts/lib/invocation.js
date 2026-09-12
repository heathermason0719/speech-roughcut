'use strict';

// Local ownership and minimum media/transcript binding, not a task checkpoint.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJson(file, value, options) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
function canonical(file) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
}
function suggestedBase(source, outputRoot = process.cwd()) {
  const name = path.basename(source, path.extname(source));
  return path.resolve(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}_${name}_${crypto.randomUUID()}`);
}
function findRecord(fileOrDir) {
  let dir = canonical(fileOrDir);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    const file = path.join(dir, 'invocation.json');
    if (fs.existsSync(file)) return { file, record: readJson(file) };
    const parent = path.dirname(dir);
    if (dir === parent) return null;
    dir = parent;
  }
}
function claimInvocation(baseArg, sourceArg) {
  const base = canonical(baseArg);
  if (findRecord(base)) throw new Error('BASE 已被 invocation 占用；请使用新的输出目录');
  for (const stage of ['1_转录', '2_分析', '3_审核']) {
    if (fs.existsSync(path.join(base, stage))) throw new Error('BASE 已包含阶段产物，不能混入新的 invocation');
  }
  fs.mkdirSync(base, { recursive: true });
  const record = {
    invocationId: crypto.randomUUID(), state: 'running', sourcePath: canonical(sourceArg),
    transcribeDir: path.join(base, '1_转录'),
    owner: { pid: process.pid, token: crypto.randomUUID() },
  };
  const file = path.join(base, 'invocation.json');
  try { writeJson(file, record, { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('BASE 已被 invocation 所有者占用；请使用新的输出目录');
    throw error;
  }
  return { file, record };
}
function writerForDir(dir, source, credentials = process.env) {
  const found = findRecord(dir);
  if (!found) {
    if (credentials.SPEECH_ROUGHCUT_INVOCATION) throw new Error('invocation 所有权记录缺失');
    return null; // Standalone utilities remain usable outside a formal BASE.
  }
  const { record } = found;
  if (record.state !== 'running'
      || record.invocationId !== credentials.SPEECH_ROUGHCUT_INVOCATION
      || record.owner.token !== credentials.SPEECH_ROUGHCUT_OWNER
      || canonical(dir) !== record.transcribeDir) {
    throw new Error('invocation 写入所有权不匹配；请从 run_transcribe.sh 使用新的 BASE');
  }
  try { process.kill(record.owner.pid, 0); } catch (_) { throw new Error('invocation 活动所有者已退出'); }
  if (source && canonical(source) !== record.sourcePath) throw new Error('invocation 原始媒体身份不匹配');
  return found;
}
function finishInvocation(claim, state) {
  const current = readJson(claim.file);
  if (current.owner.token !== claim.record.owner.token) throw new Error('invocation 所有者变化');
  writeJson(claim.file, { ...current, state });
}
function verifyContextIdentity(contextFile, context, { complete = false } = {}) {
  const found = findRecord(contextFile);
  if (!found && !context.invocationId) return null;
  if (!found || !context.invocationId) throw new Error('invocation 身份记录缺失');
  const { record } = found;
  if (record.invocationId !== context.invocationId
      || canonical(contextFile) !== path.join(record.transcribeDir, 'media_context.json')
      || context.sourcePath !== record.sourcePath
      || context.reviewAudioPath !== path.join(record.transcribeDir, 'review_audio.mp3')) {
    throw new Error('media context 的 invocation 身份不匹配');
  }
  if (complete && record.state !== 'complete') throw new Error('invocation 转录尚未完整完成，不能进入审核');
  return found;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fileIdentity(file) { return { path: canonical(file), sha256: digest(file) }; }
function verifyFile(file, identity) {
  if (!identity || canonical(file) !== identity.path || digest(file) !== identity.sha256) {
    throw new Error('转录产物的 invocation 归属不匹配或内容已变化');
  }
}
function bindResult(dir, credentials = process.env) {
  const found = writerForDir(dir, undefined, credentials);
  if (!found) return;
  const context = readJson(path.join(dir, 'media_context.json'));
  verifyContextIdentity(path.join(dir, 'media_context.json'), context);
  writeJson(path.join(dir, 'result_identity.json'), {
    invocationId: found.record.invocationId, reviewFingerprint: context.reviewFingerprint,
    result: fileIdentity(path.join(dir, 'volcengine_v3_result.json')),
  });
}
function verifyResult(resultFile, contextFile, context, outDir) {
  const outputOwner = writerForDir(outDir);
  const found = verifyContextIdentity(contextFile, context);
  if (Boolean(found) !== Boolean(outputOwner)
      || (found && found.record.invocationId !== outputOwner.record.invocationId)) {
    throw new Error('转录输入与输出目录的 invocation 身份不匹配');
  }
  if (!found) return;
  writerForDir(path.dirname(contextFile));
  const identity = readJson(path.join(found.record.transcribeDir, 'result_identity.json'));
  if (identity.invocationId !== context.invocationId
      || !isDeepStrictEqual(identity.reviewFingerprint, context.reviewFingerprint)) {
    throw new Error('转录入口的 invocation 身份不匹配');
  }
  verifyFile(resultFile, identity.result);
}
function bindTranscript(dir) {
  const found = writerForDir(dir);
  if (!found) return;
  const identity = readJson(path.join(dir, 'result_identity.json'));
  writeJson(path.join(dir, 'transcript_identity.json'), {
    ...identity, words: fileIdentity(path.join(dir, 'subtitles_words.json')),
    asrBreaks: fileIdentity(path.join(dir, 'asr_breaks.json')),
  });
}
function verifyTranscript(contextFile, context, wordsFile, breaksFile) {
  const found = verifyContextIdentity(contextFile, context, { complete: true });
  if (!found) {
    if (findRecord(wordsFile) || findRecord(breaksFile)) throw new Error('未绑定的 context 不能消费正式 invocation 转录');
    return null;
  }
  const identity = readJson(path.join(found.record.transcribeDir, 'transcript_identity.json'));
  if (identity.invocationId !== context.invocationId
      || !isDeepStrictEqual(identity.reviewFingerprint, context.reviewFingerprint)) {
    throw new Error('转录与审核媒体的 invocation 身份不匹配');
  }
  verifyFile(path.join(found.record.transcribeDir, 'volcengine_v3_result.json'), identity.result);
  verifyFile(wordsFile, identity.words);
  verifyFile(breaksFile, identity.asrBreaks);
  return identity;
}
function verifyReviewDirectory(contextFile, context, outDir) {
  const found = verifyContextIdentity(contextFile, context, { complete: true });
  if (!found) {
    if (findRecord(outDir)) throw new Error('未绑定的 context 不能写入正式 invocation 审核目录');
    return null;
  }
  if (canonical(outDir) !== path.join(path.dirname(found.file), '3_审核')) {
    throw new Error('审核输出目录不属于当前 invocation，必须使用当前 BASE/3_审核');
  }
  return found;
}
function acquireReviewWriter(contextFile, context, outDir) {
  const found = verifyReviewDirectory(contextFile, context, outDir);
  if (!found) return () => {};
  const lockFile = path.join(path.dirname(found.file), '.review-writer.json');
  const token = crypto.randomUUID();
  try {
    writeJson(lockFile, { invocationId: context.invocationId, pid: process.pid, token }, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('invocation 审核生成已有写入所有者，不能并发生成');
    throw error;
  }
  return () => {
    if (readJson(lockFile).token !== token) throw new Error('invocation 审核写入所有者变化');
    fs.unlinkSync(lockFile);
  };
}
function verifyReviewIdentity(contextFile, context, data, reviewDir = process.cwd()) {
  const dir = path.dirname(contextFile);
  const wordsFile = path.join(dir, 'subtitles_words.json');
  const breaksFile = path.join(dir, 'asr_breaks.json');
  const found = verifyReviewDirectory(contextFile, context, reviewDir);
  if (!found) return;
  if (fs.existsSync(path.join(path.dirname(found.file), '.review-writer.json'))) {
    throw new Error('invocation 审核数据仍在生成，不能进入审核');
  }
  verifyTranscript(contextFile, context, wordsFile, breaksFile);
  if (data.invocationId !== context.invocationId
      || !isDeepStrictEqual(data.words, readJson(wordsFile))
      || !isDeepStrictEqual(data.asrBreaks, readJson(breaksFile))) {
    throw new Error('审核数据与转录的 invocation 身份不匹配');
  }
}

if (require.main === module) {
  try {
    const [command, first, second] = process.argv.slice(2);
    if (command === 'new-base' && first) process.stdout.write(`${suggestedBase(first, second)}\n`);
    else if (command === 'provider-write' && first && second) {
      const found = writerForDir(first);
      if (found) {
        const context = readJson(path.join(first, 'media_context.json'));
        verifyContextIdentity(path.join(first, 'media_context.json'), context);
        if (canonical(second) !== context.reviewAudioPath) throw new Error('provider 输入与 invocation 审核资产不匹配');
      }
    } else throw new Error('用法: invocation.js new-base <media> [root] | provider-write <outDir> <audio>');
  } catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}
module.exports = {
  acquireReviewWriter, bindResult, bindTranscript, canonical, claimInvocation, finishInvocation, suggestedBase,
  verifyContextIdentity, verifyResult, verifyReviewIdentity, verifyTranscript, writerForDir,
};
