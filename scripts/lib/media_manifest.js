'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  REVIEW_BITRATE_KBPS,
  REVIEW_CHANNELS,
  REVIEW_SAMPLE_RATE,
} = require('./time_contract');

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov']);
const MEDIA_CONTEXT_FILE = 'media_context.json';
const REVIEW_AUDIO_FILE = 'review_audio.mp3';

function execJson(command, args) {
  const raw = execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function gcd(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left || 1;
}

function parseRational(value) {
  const match = String(value || '').match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!(numerator > 0) || !(denominator > 0)) return null;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function rationalEqual(left, right) {
  return !!left && !!right
    && left.numerator * right.denominator === right.numerator * left.denominator;
}

function fileFingerprint(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    dev: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function fingerprintsEqual(left, right) {
  return !!left && !!right
    && ['dev', 'inode', 'size', 'mtimeNs'].every(field => String(left[field]) === String(right[field]));
}

function readAudioPacketTimeline(filePath) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_packets', '-show_entries', 'packet=pts_time,duration_time',
    '-of', 'compact=p=0:nk=0', filePath,
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return raw.split(/\r?\n/).filter(Boolean).map(line => {
    const record = {};
    for (const field of line.split('|')) {
      const separator = field.indexOf('=');
      if (separator >= 0) record[field.slice(0, separator)] = field.slice(separator + 1);
    }
    return {
      pts: parseNumber(record.pts_time, NaN),
      duration: parseNumber(record.duration_time, NaN),
    };
  }).filter(packet => Number.isFinite(packet.pts) && Number.isFinite(packet.duration) && packet.duration > 0);
}

function verifyAudioTimeline(filePath, sampleRate) {
  const packets = readAudioPacketTimeline(filePath);
  if (!packets.length) throw new Error('无法证明音频时间戳连续、单调且 rate=1');
  const tolerance = Math.max(1 / sampleRate, 0.000002);
  const durations = packets.map(packet => packet.duration).sort((left, right) => left - right);
  const nominalDuration = durations[Math.floor(durations.length / 2)];
  const first = packets[0];
  const startsAtZero = Math.abs(first.pts) <= tolerance;
  const encoderPrerollToZero = first.pts < 0 && Math.abs(first.pts + first.duration) <= tolerance;
  if (!startsAtZero && !encoderPrerollToZero) {
    throw new Error(`源音轨 presentation start 必须为 0（检测到 ${first.pts.toFixed(6)}s）`);
  }
  let previous = first;
  for (let index = 1; index < packets.length; index += 1) {
    const packet = packets[index];
    if (index < packets.length - 1 && Math.abs(packet.duration - nominalDuration) > tolerance) {
      throw new Error(`音频时间戳不连续，无法证明 rate=1（packet ${index} duration 异常）`);
    }
    if (!(packet.pts > previous.pts - tolerance)) {
      throw new Error('音频时间戳必须连续且单调，无法证明 rate=1');
    }
    const gap = packet.pts - (previous.pts + previous.duration);
    if (Math.abs(gap) > tolerance) {
      throw new Error(`音频时间戳不连续（packet ${index} 偏差 ${gap.toFixed(6)}s）`);
    }
    previous = packet;
  }
  const presentationEnd = packets.reduce(
    (maximum, packet) => Math.max(maximum, packet.pts + packet.duration),
    0,
  );
  return {
    rate: 1,
    presentationStart: 0,
    presentationEnd,
    packetCount: packets.length,
  };
}

function readVideoFrameTimeline(filePath, frameSeconds, streamIndex) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', String(streamIndex),
    '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time,duration_time',
    '-of', 'compact=p=0:nk=0', filePath,
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  let frameCount = 0;
  let presentationEnd = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const record = {};
    for (const field of line.split('|')) {
      const separator = field.indexOf('=');
      if (separator >= 0) record[field.slice(0, separator)] = field.slice(separator + 1);
    }
    const start = parseNumber(record.best_effort_timestamp_time, NaN);
    if (!Number.isFinite(start)) continue;
    const duration = parseNumber(
      record.pkt_duration_time,
      parseNumber(record.duration_time, frameSeconds),
    );
    frameCount += 1;
    presentationEnd = Math.max(
      presentationEnd,
      start + (duration > 0 ? duration : frameSeconds),
    );
  }
  if (!frameCount || !(presentationEnd > 0)) {
    throw new Error('无法证明视频帧终点');
  }
  return { frameCount, presentationEnd };
}

function verifyCfr(filePath, videoStream) {
  const rFrameRate = parseRational(videoStream.r_frame_rate);
  const avgFrameRate = parseRational(videoStream.avg_frame_rate);
  if (!rationalEqual(rFrameRate, avgFrameRate)) {
    throw new Error('仅支持 CFR，请先转码为 CFR 后重新执行');
  }
  const result = spawnSync('ffmpeg', [
    '-v', 'info', '-i', filePath,
    '-map', `0:${videoStream.index}`, '-an', '-vf', 'vfrdet', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  const match = String(result.stderr || '').match(/VFR:([\d.]+)/);
  if (result.status !== 0 || !match) {
    throw new Error('无法可靠判定帧节奏；仅支持 CFR，请先转码为 CFR 后重新执行');
  }
  if (Number(match[1]) !== 0) {
    throw new Error('仅支持 CFR，请先转码为 CFR 后重新执行');
  }
  const startTime = parseNumber(videoStream.start_time, 0);
  const frameSeconds = rFrameRate.denominator / rFrameRate.numerator;
  if (Math.abs(startTime) > frameSeconds / 1000) {
    throw new Error(`视频 presentation start 必须为 0（检测到 ${startTime.toFixed(6)}s）`);
  }
  const frameTimeline = readVideoFrameTimeline(filePath, frameSeconds, videoStream.index);
  return {
    fpsNum: rFrameRate.numerator,
    fpsDen: rFrameRate.denominator,
    isCfr: true,
    presentationStart: 0,
    presentationEnd: frameTimeline.presentationEnd,
    frameCount: frameTimeline.frameCount,
  };
}

function probeMedia(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`媒体文件不存在: ${resolved}`);
  const extension = path.extname(resolved).slice(1).toLowerCase();
  const info = execJson('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=format_name:stream=index,codec_type,codec_name,sample_rate,channels,width,height,r_frame_rate,avg_frame_rate,time_base,start_time:stream_disposition=attached_pic',
    '-of', 'json', resolved,
  ]);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  const videoStreams = streams.filter(stream => stream.codec_type === 'video'
    && Number(stream.disposition && stream.disposition.attached_pic) !== 1);
  if (audioStreams.length !== 1) {
    throw new Error(`每次 invocation 只支持一个连续主音轨（检测到 ${audioStreams.length} 条音轨）`);
  }
  const mediaType = videoStreams.length ? 'video' : 'audio';
  if (mediaType === 'audio' && !AUDIO_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的音频格式: ${extension || '(无扩展名)'}`);
  }
  if (mediaType === 'video' && (!VIDEO_EXTENSIONS.has(extension) || videoStreams.length !== 1)) {
    throw new Error('视频只支持单视频流的 MP4、M4V、MOV');
  }
  const audio = audioStreams[0];
  const sampleRate = Number.parseInt(audio.sample_rate, 10);
  const channels = Number.parseInt(audio.channels, 10);
  if (!(sampleRate > 0) || !(channels > 0)) throw new Error('源音轨缺少有效采样率或声道数');
  const audioTimeline = verifyAudioTimeline(resolved, sampleRate);
  const source = {
    extension,
    audioStreamIndex: Number(audio.index),
    audioCodec: String(audio.codec_name || ''),
    sampleRate,
    channels,
    rate: audioTimeline.rate,
    presentationStart: audioTimeline.presentationStart,
    audioPresentationEnd: audioTimeline.presentationEnd,
  };
  if (mediaType === 'video') {
    const video = videoStreams[0];
    const cfr = verifyCfr(resolved, video);
    const frameSeconds = cfr.fpsDen / cfr.fpsNum;
    const endpointDeltaSeconds = Math.abs(
      cfr.presentationEnd - audioTimeline.presentationEnd,
    );
    if (endpointDeltaSeconds > frameSeconds + 1 / sampleRate) {
      throw new Error(
        `音画流终点不一致: video=${cfr.presentationEnd.toFixed(6)}s, `
        + `audio=${audioTimeline.presentationEnd.toFixed(6)}s`,
      );
    }
    source.video = {
      streamIndex: Number(video.index),
      codec: String(video.codec_name || ''),
      width: Number(video.width),
      height: Number(video.height),
      ...cfr,
      endpointDeltaSeconds,
      endpointsSynchronized: true,
    };
  }
  return {
    path: resolved,
    mediaType,
    sizeBytes: Number(fs.statSync(resolved).size),
    source,
  };
}

function findSkipSamples(packet) {
  const sideData = Array.isArray(packet && packet.side_data_list) ? packet.side_data_list : [];
  return sideData.find(item => item.side_data_type === 'Skip Samples') || null;
}

function probeReviewGapless(reviewPath, reviewDuration) {
  const firstInfo = execJson('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-read_intervals', '%+#1',
    '-show_packets', '-show_entries', 'packet=side_data_list', '-of', 'json', reviewPath,
  ]);
  const first = findSkipSamples((firstInfo.packets || [])[0]);
  const tailStart = Math.max(0, reviewDuration - 0.25).toFixed(6);
  const tailInfo = execJson('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-read_intervals', `${tailStart}%`,
    '-show_packets', '-show_entries', 'packet=side_data_list', '-of', 'json', reviewPath,
  ]);
  const tailPackets = Array.isArray(tailInfo.packets) ? tailInfo.packets : [];
  const tailEntries = tailPackets.map(findSkipSamples).filter(Boolean);
  const last = tailEntries.find(entry => Number(entry.discard_padding) >= 0) || null;
  const skipSamples = first ? Number(first.skip_samples) : 0;
  const discardPaddingSamples = last ? Number(last.discard_padding) : -1;
  return {
    skipSamples,
    discardPaddingSamples,
    gaplessMetadataVerified: skipSamples > 0 && discardPaddingSamples >= 0,
  };
}

function buildMediaContext({
  sourcePath,
  reviewAudioPath,
  sourceMedia,
  sourceDecodedSampleCount,
  reviewDecodedSampleCount,
}) {
  const source = path.resolve(sourcePath);
  const review = path.resolve(reviewAudioPath);
  const reviewDuration = reviewDecodedSampleCount / REVIEW_SAMPLE_RATE;
  const gapless = probeReviewGapless(review, reviewDuration);
  if (!gapless.gaplessMetadataVerified) {
    throw new Error('review_audio.mp3 缺少可识别的 encoder delay / discard padding 元数据');
  }
  const mediaType = sourceMedia.mediaType;
  const timebase = mediaType === 'audio'
    ? { kind: 'audio-samples', ticksPerSecond: sourceMedia.source.sampleRate }
    : {
      kind: 'video-frames',
      fpsNum: sourceMedia.source.video.fpsNum,
      fpsDen: sourceMedia.source.video.fpsDen,
    };
  return {
    sourcePath: source,
    reviewAudioPath: review,
    playbackPath: mediaType === 'audio' ? review : source,
    exportPath: source,
    mediaType,
    source: {
      ...sourceMedia.source,
      normalizedDecodedSampleCount: sourceDecodedSampleCount,
    },
    review: {
      extension: 'mp3',
      sizeBytes: Number(fs.statSync(review).size),
      sampleRate: REVIEW_SAMPLE_RATE,
      channels: REVIEW_CHANNELS,
      bitrateKbps: REVIEW_BITRATE_KBPS,
      decodedSampleCount: reviewDecodedSampleCount,
      duration: reviewDuration,
      ...gapless,
    },
    timebase,
    offsets: {
      playerPresentationOffset: { seconds: 0, status: 'verified' },
      asrPresentationOffset: { seconds: 0, status: 'pending_user_validation' },
      sourceMediaOffset: { seconds: 0, status: 'verified' },
    },
    sourceFingerprint: fileFingerprint(source),
    reviewFingerprint: fileFingerprint(review),
  };
}

function writeMediaContext(contextPath, context) {
  const resolved = path.resolve(contextPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(context, null, 2)}\n`);
}

function loadAndVerifyMediaContext(contextPath) {
  const resolved = path.resolve(contextPath);
  const context = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  for (const field of ['sourcePath', 'reviewAudioPath', 'playbackPath', 'exportPath', 'sourceFingerprint', 'reviewFingerprint']) {
    if (!context[field]) throw new Error(`media context 缺少字段: ${field}`);
  }
  if (!fs.existsSync(context.sourcePath)) throw new Error(`原始媒体不存在: ${context.sourcePath}`);
  if (!fs.existsSync(context.reviewAudioPath)) throw new Error(`审核音频不存在: ${context.reviewAudioPath}`);
  if (!fingerprintsEqual(fileFingerprint(context.sourcePath), context.sourceFingerprint)) {
    throw new Error(`原始媒体轻量指纹已变化: ${context.sourcePath}`);
  }
  if (!fingerprintsEqual(fileFingerprint(context.reviewAudioPath), context.reviewFingerprint)) {
    throw new Error(`审核音频轻量指纹已变化: ${context.reviewAudioPath}`);
  }
  if (!context.source || context.source.rate !== 1) {
    throw new Error('media context 无法证明 rate=1');
  }
  if (context.source.presentationStart !== 0) {
    throw new Error('源音轨 presentation start 必须为 0');
  }
  if (!Number.isInteger(context.source.sampleRate)
      || context.source.sampleRate <= 0
      || !Number.isInteger(context.source.channels)
      || context.source.channels <= 0) {
    throw new Error('源音轨缺少有效采样率或声道数');
  }
  if (path.resolve(context.exportPath) !== path.resolve(context.sourcePath)) {
    throw new Error('media context 的导出资产必须是原始媒体');
  }
  if (context.mediaType === 'video') {
    const video = context.source.video;
    if (!video || video.isCfr !== true) {
      throw new Error('仅支持 CFR，请先转码为 CFR 后重新执行');
    }
    if (video.presentationStart !== 0) {
      throw new Error('视频 presentation start 必须为 0');
    }
    if (!Number.isInteger(video.fpsNum)
        || video.fpsNum <= 0
        || !Number.isInteger(video.fpsDen)
        || video.fpsDen <= 0) {
      throw new Error('media context 的 CFR timebase 无效');
    }
    const frameSeconds = video.fpsDen / video.fpsNum;
    const endpointDeltaSeconds = Math.abs(
      Number(video.presentationEnd) - Number(context.source.audioPresentationEnd),
    );
    if (video.endpointsSynchronized !== true
        || !Number.isFinite(video.presentationEnd)
        || !Number.isFinite(context.source.audioPresentationEnd)
        || !Number.isFinite(video.endpointDeltaSeconds)
        || endpointDeltaSeconds > frameSeconds + 1 / context.source.sampleRate
        || Math.abs(endpointDeltaSeconds - video.endpointDeltaSeconds) > 0.000002) {
      throw new Error('音画流终点同步证明无效');
    }
    if (!context.timebase || context.timebase.kind !== 'video-frames'
        || context.timebase.fpsNum !== video.fpsNum
        || context.timebase.fpsDen !== video.fpsDen) {
      throw new Error('media context 的 CFR timebase 无效');
    }
    if (path.resolve(context.playbackPath) !== path.resolve(context.sourcePath)) {
      throw new Error('视频播放器必须使用原始媒体');
    }
  } else if (context.mediaType === 'audio') {
    if (!context.timebase || context.timebase.kind !== 'audio-samples'
        || context.timebase.ticksPerSecond !== context.source.sampleRate) {
      throw new Error('media context 的源音频 sample timebase 无效');
    }
    if (path.resolve(context.playbackPath) !== path.resolve(context.reviewAudioPath)) {
      throw new Error('纯音频播放器必须使用统一审核音频');
    }
  } else {
    throw new Error('media context 的媒体类型无效');
  }
  if (!context.review
      || context.review.sampleRate !== REVIEW_SAMPLE_RATE
      || context.review.channels !== REVIEW_CHANNELS
      || !(context.review.decodedSampleCount > 0)
      || context.review.duration !== context.review.decodedSampleCount / REVIEW_SAMPLE_RATE) {
    throw new Error('media context 的 review sample clock 无效');
  }
  for (const name of ['playerPresentationOffset', 'sourceMediaOffset']) {
    const offset = context.offsets && context.offsets[name];
    if (!offset || offset.status !== 'verified' || !Number.isFinite(offset.seconds)) {
      throw new Error(`${name} 未验证`);
    }
  }
  const asrOffset = context.offsets && context.offsets.asrPresentationOffset;
  if (!asrOffset || !['pending_user_validation', 'verified'].includes(asrOffset.status)) {
    throw new Error('asrPresentationOffset 状态无效');
  }
  return context;
}

module.exports = {
  AUDIO_EXTENSIONS,
  MEDIA_CONTEXT_FILE,
  REVIEW_AUDIO_FILE,
  VIDEO_EXTENSIONS,
  buildMediaContext,
  fileFingerprint,
  fingerprintsEqual,
  loadAndVerifyMediaContext,
  parseRational,
  probeMedia,
  probeReviewGapless,
  writeMediaContext,
};
