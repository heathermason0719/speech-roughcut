'use strict';

const { spawn } = require('node:child_process');

function runProcess(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.trim()}`));
    });
  });
}

function streamDecodedPcm(filePath, {
  sampleRate,
  streamIndex,
  onChunk = () => {},
} = {}) {
  if (!(sampleRate > 0)) throw new Error('sampleRate 必须为正数');
  const map = Number.isInteger(streamIndex) ? `0:${streamIndex}` : '0:a:0';
  const args = [
    '-v', 'error', '-i', filePath,
    '-map', map, '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 's16le', '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let carry = Buffer.alloc(0);
    let decodedSampleCount = 0;
    let failed = false;

    const fail = error => {
      if (failed) return;
      failed = true;
      child.kill('SIGTERM');
      reject(error);
    };

    child.stderr.on('data', chunk => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.stdout.on('data', chunk => {
      if (failed) return;
      try {
        const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const evenLength = joined.length - (joined.length % 2);
        const pcm = joined.subarray(0, evenLength);
        carry = evenLength < joined.length ? Buffer.from(joined.subarray(evenLength)) : Buffer.alloc(0);
        if (pcm.length) {
          decodedSampleCount += pcm.length / 2;
          onChunk(pcm);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.once('error', fail);
    child.once('close', code => {
      if (failed) return;
      if (code !== 0) {
        reject(new Error(`ffmpeg PCM 解码失败（退出码 ${code}）: ${stderr.trim()}`));
        return;
      }
      if (carry.length) {
        reject(new Error('ffmpeg PCM 输出包含不完整的 16-bit sample'));
        return;
      }
      resolve(decodedSampleCount);
    });
  });
}

async function countDecodedSamples(filePath, options) {
  return streamDecodedPcm(filePath, options);
}

module.exports = {
  countDecodedSamples,
  runProcess,
  streamDecodedPcm,
};
