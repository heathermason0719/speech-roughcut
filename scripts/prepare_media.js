#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  buildMediaContext,
  MEDIA_CONTEXT_FILE,
  probeMedia,
  REVIEW_AUDIO_FILE,
  writeMediaContext,
} = require('./lib/media_manifest');
const { countDecodedSamples, runProcess } = require('./lib/pcm_stream');
const {
  REVIEW_BITRATE_KBPS,
  REVIEW_SAMPLE_RATE,
} = require('./lib/time_contract');

async function prepareMedia(sourceArg, transcribeDirArg) {
  const sourcePath = path.resolve(sourceArg);
  const transcribeDir = path.resolve(transcribeDirArg);

  // 所有硬性探测必须先于审核文件生成，保证不支持输入在任何上传或派生副作用前失败。
  const sourceMedia = probeMedia(sourcePath);
  fs.mkdirSync(transcribeDir, { recursive: true });

  const reviewPath = path.join(transcribeDir, REVIEW_AUDIO_FILE);
  const temporaryReviewPath = path.join(
    transcribeDir,
    `.review_audio.${process.pid}.${Date.now()}.mp3`,
  );
  try {
    const sourceDecodedSampleCount = await countDecodedSamples(sourcePath, {
      sampleRate: REVIEW_SAMPLE_RATE,
      streamIndex: sourceMedia.source.audioStreamIndex,
    });
    await runProcess('ffmpeg', [
      '-v', 'error', '-i', sourcePath,
      '-map', `0:${sourceMedia.source.audioStreamIndex}`,
      '-vn',
      '-af', `aresample=${REVIEW_SAMPLE_RATE}:async=0,asetpts=N/SR/TB`,
      '-ac', '1', '-ar', String(REVIEW_SAMPLE_RATE),
      '-c:a', 'libmp3lame', '-b:a', `${REVIEW_BITRATE_KBPS}k`,
      '-write_xing', '1', '-id3v2_version', '3',
      '-y', temporaryReviewPath,
    ]);
    const reviewDecodedSampleCount = await countDecodedSamples(temporaryReviewPath, {
      sampleRate: REVIEW_SAMPLE_RATE,
      streamIndex: 0,
    });
    if (Math.abs(sourceDecodedSampleCount - reviewDecodedSampleCount) > 1) {
      throw new Error(
        `审核音频 sample count 不一致: source=${sourceDecodedSampleCount}, review=${reviewDecodedSampleCount}`,
      );
    }
    fs.renameSync(temporaryReviewPath, reviewPath);
    const context = buildMediaContext({
      sourcePath,
      reviewAudioPath: reviewPath,
      sourceMedia,
      sourceDecodedSampleCount,
      reviewDecodedSampleCount,
    });
    writeMediaContext(path.join(transcribeDir, MEDIA_CONTEXT_FILE), context);
    console.error(`✅ 已生成统一审核音频: ${reviewPath}`);
    process.stdout.write(`${reviewPath}\n`);
    return context;
  } finally {
    if (fs.existsSync(temporaryReviewPath)) fs.rmSync(temporaryReviewPath);
  }
}

if (require.main === module) {
  const sourceArg = process.argv[2];
  const transcribeDirArg = process.argv[3];
  if (!sourceArg || !transcribeDirArg) {
    console.error('用法: node prepare_media.js <source_media> <transcribe_dir>');
    process.exit(1);
  }
  prepareMedia(sourceArg, transcribeDirArg).catch(error => {
    console.error(`❌ 媒体准备失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { prepareMedia };
