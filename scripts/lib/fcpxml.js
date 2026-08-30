'use strict';
/*
 * FCPXML 1.8 生成（从 review_server.js 抽出，便于单测）。
 *
 * 一句话职责：拿到「删除段 + 静音段 + 媒体文件」，算出真正保留的片段（复用
 * compute_keeps.js 这一份切割算法），再渲染成可被剪映 / Final Cut Pro 导入的 FCPXML。
 *
 * 设计约束（改动前必读）：
 *   - FCPXML 1.8 DTD 不支持 fade 元素，淡入淡出留给剪辑软件自己加
 *   - 媒体引用用绝对路径的 file:// URI（百分号编码），剪映和 FCP 都靠它定位源文件
 *   - 视频时间使用帧时基；纯音频使用采样率时基，避免浮点累积和无视频帧率导致的 0/0s
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { computeFinalKeeps } = require('./compute_keeps');
const { buildSubtitleBlocks } = require('./subtitle_blocks');
const { selectedIndicesToSegments } = require('./selection_segments');

const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

// 把绝对路径编码成 file:// URI（保留路径分隔符与安全字符，其余百分号编码）
function fileUri(absPath) {
  return 'file://' + absPath.split('').map(c => (
    /[a-zA-Z0-9\-_.~/]/.test(c) ? c : encodeURIComponent(c)
  )).join('');
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

// FCP 要求的 UUID 格式
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 一次 ffprobe 同时探测容器、视频流和音频流，避免纯音频被误当成 0fps 视频。
function probeMedia(mediaFile) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,duration,r_frame_rate,width,height,sample_rate,channels',
    '-of', 'json',
    path.resolve(mediaFile),
  ], { encoding: 'utf8' });
  const info = JSON.parse(raw);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const duration = parseFloat(info.format && info.format.duration)
    || Math.max(0, ...streams.map(stream => parseFloat(stream.duration) || 0));

  if (!(duration > 0)) throw new Error(`无法读取媒体时长: ${mediaFile}`);
  if (!video && !audio) throw new Error(`媒体不包含可用的音频或视频流: ${mediaFile}`);

  if (!video) {
    const sampleRate = parseInt(audio.sample_rate, 10) || 48000;
    return {
      duration,
      isAudioOnly: true,
      sampleRate,
      audioChannels: parseInt(audio.channels, 10) || 2,
      fpsNum: 25,
      fpsDen: 1,
      width: 1920,
      height: 1080,
    };
  }

  // 帧率为有理数，如 "30000/1001" = 29.97fps。
  const fpsParts = String(video.r_frame_rate || '').split('/').map(Number);
  const fpsNum = fpsParts[0];
  const fpsDen = fpsParts.length === 2 ? fpsParts[1] : 1;
  if (!(fpsNum > 0) || !(fpsDen > 0)) throw new Error(`无法读取视频帧率: ${mediaFile}`);

  return {
    duration,
    isAudioOnly: false,
    sampleRate: 48000,
    audioChannels: 2,
    fpsNum,
    fpsDen,
    width: parseInt(video.width, 10) || 1920,
    height: parseInt(video.height, 10) || 1080,
  };
}

function fcpxmlAudioRate(sampleRate) {
  return `${sampleRate / 1000}k`;
}

/**
 * 生成 FCPXML。
 * @param {object} o
 * @param {string} o.mediaFile        源视频或音频路径
 * @param {string} [o.videoFile]      兼容旧调用方的媒体路径别名
 * @param {number[]} o.deleteList      删除段（秒区间，见 compute_keeps）
 * @param {Array} o.silencePeriods     预计算静音段
 * @param {object} [o.cutOpts]         切割参数（padStart/padEnd 等）
 * @returns {{ xml:string, outputPath:string, finalKeeps:Array, baseName:string }}
 */
function buildFcpxml({
  mediaFile,
  videoFile,
  deleteList,
  silencePeriods,
  cutOpts,
  includeTitles,
  subtitleWords,
  selectedIndices,
}) {
  const sourceFile = mediaFile || videoFile;
  if (!sourceFile) throw new Error('必须指定媒体文件路径');

  const media = probeMedia(sourceFile);
  const { duration, isAudioOnly, sampleRate, audioChannels, fpsNum, fpsDen, width, height } = media;

  // 视频 ticks = 帧号 × fpsDen；音频 ticks = 采样数。二者都用整数累加。
  const timebase = isAudioOnly ? sampleRate : fpsNum;
  const toFCPTicks = isAudioOnly
    ? (sec) => Math.round(sec * sampleRate)
    : (sec) => Math.round(sec * fpsNum / fpsDen) * fpsDen;
  const frameDuration = `${fpsDen}/${fpsNum}s`;

  // 用户恢复的词/空白是硬保护区：静音吸附和内部二次切割都不能再次吞掉它们。
  const selectedSet = new Set(selectedIndices || []);
  const protectedIndices = Array.isArray(subtitleWords)
    ? subtitleWords.map((_, index) => index).filter(index => !selectedSet.has(index))
    : [];
  const protectedSegments = Array.isArray(subtitleWords)
    ? selectedIndicesToSegments(subtitleWords, protectedIndices)
    : undefined;
  const effectiveCutOpts = protectedSegments
    ? Object.assign({}, cutOpts || {}, { protectedSegments })
    : cutOpts;

  // 切割算法单一来源：合并删除段 → 取反 → 边界吸附静音 → 内部长静音二次切
  const finalKeeps = computeFinalKeeps(deleteList, silencePeriods, duration, effectiveCutOpts);

  const baseName = path.basename(sourceFile, path.extname(sourceFile));
  const escapedBaseName = escapeXml(baseName);
  const outputPath = path.resolve(`${baseName}_cut.fcpxml`);

  const mediaSrc = fileUri(path.resolve(sourceFile));
  const fcpxmlSrc = fileUri(outputPath);

  // 视频维持原有 48k asset 时基；纯音频使用源文件真实采样率。
  const audioRate = isAudioOnly ? sampleRate : 48000;
  const assetDurationNum = Math.round(duration * audioRate);
  const audioRateName = fcpxmlAudioRate(audioRate);

  const titleBlocks = includeTitles && Array.isArray(subtitleWords)
    ? buildSubtitleBlocks({ words: subtitleWords, selectedIndices, finalKeeps })
    : [];
  const titlesByKeep = new Map();
  titleBlocks.forEach((block, index) => {
    if (!titlesByKeep.has(block.keepIndex)) titlesByKeep.set(block.keepIndex, []);
    const text = escapeXml(block.text);
    const styleId = `ts${index + 1}`;
    const offsetTicks = toFCPTicks(block.sourceStart);
    const durationTicks = Math.max(isAudioOnly ? 1 : fpsDen, toFCPTicks(block.sourceEnd - block.sourceStart));
    titlesByKeep.get(block.keepIndex).push(
      `              <title name="${text}" lane="1" offset="${offsetTicks}/${timebase}s" ref="r3" start="0/1s" duration="${durationTicks}/${timebase}s">\n` +
      `                <text><text-style ref="${styleId}">${text}</text-style></text>\n` +
      `                <text-style-def id="${styleId}"><text-style font="PingFang SC" fontSize="64" fontFace="Regular" fontColor="1 1 1 1" alignment="center">${text}</text-style></text-style-def>\n` +
      '                <adjust-transform position="0 -35" />\n' +
      '              </title>'
    );
  });

  // 每个保留片段一个 asset-clip，引用同一个 asset r1；
  // offset 在 tick 空间累加，避免浮点秒累积误差导致 ±1 帧偏移
  let timelineOffsetTicks = 0;
  const clips = finalKeeps.map((seg, keepIndex) => {
    const startTicks = toFCPTicks(seg.start);
    const durTicks = toFCPTicks(seg.end - seg.start);
    const offsetTicks = timelineOffsetTicks;
    timelineOffsetTicks += durTicks;
    const mediaAttrs = isAudioOnly ? ' srcEnable="audio"' : ' format="r2"';
    const open = `            <asset-clip name="${escapedBaseName}" offset="${offsetTicks}/${timebase}s" ref="r1" start="${startTicks}/${timebase}s" duration="${durTicks}/${timebase}s"${mediaAttrs} audioRole="dialogue" tcFormat="NDF"`;
    const titles = titlesByKeep.get(keepIndex) || [];
    return titles.length ? `${open}>\n${titles.join('\n')}\n            </asset-clip>` : `${open} />`;
  }).join('\n');

  const totalTicks = timelineOffsetTicks;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="r2" frameDuration="${frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)" />
    <asset id="r1" name="${escapedBaseName}" src="${mediaSrc}" start="0/1s" duration="${assetDurationNum}/${audioRate}s"${isAudioOnly ? '' : ' format="r2"'} hasAudio="1" hasVideo="${isAudioOnly ? 0 : 1}" audioSources="1" audioChannels="${audioChannels}" audioRate="${audioRateName}" />${titleBlocks.length ? `\n    <effect id="r3" name="Basic Title" uid="${BASIC_TITLE_UID}" />` : ''}
  </resources>
  <library location="${fcpxmlSrc}">
    <event name="${escapedBaseName}_剪辑" uid="${uuid()}">
      <project name="${escapedBaseName}_cut" uid="${uuid()}">
        <sequence duration="${totalTicks}/${timebase}s" format="r2" tcStart="0/1s" tcFormat="NDF" audioLayout="stereo" audioRate="${audioRateName}">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

  return { xml, outputPath, finalKeeps, baseName };
}

module.exports = { buildFcpxml };
