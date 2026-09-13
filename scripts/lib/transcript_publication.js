'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./atomic_file');
const { validateCanonicalTranscript } = require('./canonical_transcript');
const { writerForDir, verifyContextIdentity } = require('./invocation');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function publishTranscript({ dir, context, transcript, rawPath, credentials = process.env }) {
  const owner = writerForDir(dir, undefined, credentials);
  if (!owner) throw new Error('正式转录发布必须有 invocation 所有者');
  verifyContextIdentity(path.join(dir, 'media_context.json'), context);
  validateCanonicalTranscript(transcript, context);
  const raw = fs.readFileSync(rawPath);
  JSON.parse(raw.toString('utf8'));
  const container = path.join(dir, '.transcripts');
  fs.mkdirSync(container, { recursive: true });
  const current = path.join(container, 'current');
  if (fs.existsSync(current)) throw new Error('已有正式成功 transcript，不允许覆盖；请校验已有结果');
  const id = crypto.randomUUID();
  const generation = path.join(container, id);
  const pointer = path.join(container, `.current-${id}`);
  fs.mkdirSync(generation);
  const contents = {
    'volcengine_v3_result.json': raw,
    'transcript.json': encode(transcript),
    'subtitles_words.json': encode(transcript.words),
    'asr_breaks.json': encode(transcript.asrBreaks),
  };
  const identity = name => ({ path: path.join(generation, name), sha256: digest(contents[name]) });
  const resultIdentity = { invocationId: context.invocationId, reviewFingerprint: context.reviewFingerprint,
    result: identity('volcengine_v3_result.json') };
  contents['result_identity.json'] = encode(resultIdentity);
  contents['transcript_identity.json'] = encode({ ...resultIdentity,
    words: identity('subtitles_words.json'), asrBreaks: identity('asr_breaks.json'),
    canonical: identity('transcript.json'),
  });
  const created = [];
  let published = false;
  try {
    for (const [name, data] of Object.entries(contents)) atomicWrite(path.join(generation, name), data);
    // Aliases never expose a partial generation: current is installed last.
    for (const name of Object.keys(contents)) {
      const alias = path.join(dir, name);
      const target = `.transcripts/current/${name}`;
      let stat;
      try { stat = fs.lstatSync(alias); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (!stat.isSymbolicLink() || fs.readlinkSync(alias) !== target) throw new Error(`转录发布路径已被占用: ${name}`);
      } else { fs.symlinkSync(target, alias); created.push(alias); }
    }
    fs.symlinkSync(id, pointer, 'dir');
    fs.renameSync(pointer, current);
    published = true;
  } finally {
    if (!published) {
      for (const file of created) fs.unlinkSync(file);
      fs.rmSync(pointer, { force: true });
      fs.rmSync(generation, { recursive: true, force: true });
    }
  }
}
module.exports = { publishTranscript };
