'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 48000;

function writeMonoWav(filePath, {
  duration = 1.5,
  sampleRate = SAMPLE_RATE,
  sampleAt = () => 0,
} = {}) {
  const sampleCount = Math.round(duration * sampleRate);
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.max(-1, Math.min(1, sampleAt(index, index / sampleRate)));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function makeMarkerWav(dir, {
  duration = 1.5,
  markers = [0.1, 0.7, 1.3],
  markerDuration = 0.03,
} = {}) {
  const filePath = path.join(dir, 'markers.wav');
  return writeMonoWav(filePath, {
    duration,
    sampleAt(_index, time) {
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
        const marker = markers[markerIndex];
        if (time >= marker && time < marker + markerDuration) {
          const frequency = 800 + markerIndex * 400;
          return 0.85 * Math.sin(2 * Math.PI * frequency * (time - marker));
        }
      }
      return 0;
    },
  });
}

function encodeAudio(sourceWav, outputPath) {
  const extension = path.extname(outputPath).slice(1).toLowerCase();
  const codec = extension === 'wav'
    ? 'pcm_s16le'
    : (extension === 'm4a' ? 'aac' : 'libmp3lame');
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', sourceWav,
    '-map', '0:a:0', '-c:a', codec,
    ...(extension === 'mp3' ? ['-b:a', '96k'] : []),
    '-y', outputPath,
  ]);
  return outputPath;
}

function makeAudio(dir, extension, options = {}) {
  const wav = makeMarkerWav(dir, options);
  if (extension === 'wav') return wav;
  return encodeAudio(wav, path.join(dir, `source.${extension}`));
}

function makeCfrVideo(dir, extension, options = {}) {
  const audio = makeMarkerWav(dir, options);
  const output = path.join(dir, `source.${extension}`);
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=30000/1001:d=${options.duration || 1.5}`,
    '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr', '-c:a', 'aac', '-shortest',
    '-y', output,
  ]);
  return output;
}

function makeMismatchedAvVideo(dir, {
  videoDuration,
  audioDuration,
  name = 'source-av-mismatch.mp4',
}) {
  const audio = makeMarkerWav(dir, { duration: audioDuration });
  const output = path.join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=30000/1001:d=${videoDuration}`,
    '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr', '-c:a', 'aac',
    '-y', output,
  ]);
  return output;
}

function makeVfrVideo(dir) {
  const audio = makeMarkerWav(dir, { duration: 2.5 });
  const output = path.join(dir, 'source-vfr.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1.5',
    '-i', audio,
    '-filter:v', "setpts='if(lt(N,15),N/(30*TB),0.5/TB+(N-15)/(15*TB))'",
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr',
    '-c:a', 'aac', '-shortest', '-y', output,
  ]);
  return output;
}

function makeMultiAudioVideo(dir) {
  const output = path.join(dir, 'source-multi-audio.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-y', output,
  ]);
  return output;
}

function makeNonZeroStartAudio(dir) {
  const audio = makeMarkerWav(dir);
  const output = path.join(dir, 'source-offset.m4a');
  execFileSync('ffmpeg', [
    '-v', 'error', '-itsoffset', '0.25', '-i', audio,
    '-map', '0:a:0', '-c:a', 'aac', '-copyts', '-y', output,
  ]);
  return output;
}

function makeTimestampGapAudio(dir) {
  const audio = makeMarkerWav(dir);
  const output = path.join(dir, 'source-gap.m4a');
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', audio,
    '-af', "asetpts='PTS+if(gte(N,24000),0.25/TB,0)'",
    '-c:a', 'aac', '-fps_mode', 'passthrough', '-y', output,
  ]);
  return output;
}

function decodedSampleCount(filePath, sampleRate = SAMPLE_RATE) {
  const pcm = execFileSync('ffmpeg', [
    '-v', 'error', '-i', filePath,
    '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-',
  ], { maxBuffer: 32 * 1024 * 1024 });
  return Math.floor(pcm.length / 2);
}

module.exports = {
  SAMPLE_RATE,
  decodedSampleCount,
  encodeAudio,
  makeAudio,
  makeCfrVideo,
  makeMarkerWav,
  makeMismatchedAvVideo,
  makeMultiAudioVideo,
  makeNonZeroStartAudio,
  makeTimestampGapAudio,
  makeVfrVideo,
  writeMonoWav,
};
