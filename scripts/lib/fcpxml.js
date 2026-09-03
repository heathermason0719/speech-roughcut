'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateCompiledCutPlan } = require('./compile_edit');

const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    const value = character === 'x' ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

function timebaseEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'audio-samples') return left.ticksPerSecond === right.ticksPerSecond;
  return left.fpsNum === right.fpsNum && left.fpsDen === right.fpsDen;
}

function ticksPerSecond(timebase) {
  return timebase.kind === 'audio-samples'
    ? timebase.ticksPerSecond
    : timebase.fpsNum / timebase.fpsDen;
}

function tickTime(tick, timebase) {
  if (!Number.isInteger(tick)) throw new Error('compiledCutPlan tick 必须为整数');
  return timebase.kind === 'audio-samples'
    ? `${tick}/${timebase.ticksPerSecond}s`
    : `${tick * timebase.fpsDen}/${timebase.fpsNum}s`;
}

function expectedSourceDurationTicks(mediaContext) {
  const review = mediaContext.review || {};
  const seconds = review.decodedSampleCount / review.sampleRate;
  return Math.ceil(seconds * ticksPerSecond(mediaContext.timebase) - 1e-9);
}

function validateExportContract(mediaContext, compiledCutPlan) {
  if (!mediaContext || !compiledCutPlan) throw new Error('缺少 media context 或 compiledCutPlan');
  validateCompiledCutPlan(compiledCutPlan);
  const source = mediaContext.source || {};
  const sourceOffset = mediaContext.offsets && mediaContext.offsets.sourceMediaOffset;
  if (source.rate !== 1 || source.presentationStart !== 0
      || !sourceOffset || sourceOffset.status !== 'verified' || sourceOffset.seconds !== 0) {
    throw new Error('media context 不满足零 source start 与 rate=1 导出合同');
  }
  if (!timebaseEqual(mediaContext.timebase, compiledCutPlan.timebase)) {
    throw new Error('compiledCutPlan timebase 与 media context 不一致');
  }
  if (compiledCutPlan.reviewSampleRate !== mediaContext.review.sampleRate
      || compiledCutPlan.reviewDecodedSampleCount !== mediaContext.review.decodedSampleCount
      || compiledCutPlan.sourceOriginTick !== 0
      || compiledCutPlan.sourceDurationTicks !== expectedSourceDurationTicks(mediaContext)) {
    throw new Error('compiledCutPlan 范围与 media context 不一致');
  }
  if (!(Number.isInteger(source.sampleRate) && source.sampleRate > 0)
      || !(Number.isInteger(source.channels) && source.channels > 0)) {
    throw new Error('media context 缺少真实音频元数据');
  }
  if (mediaContext.mediaType === 'video') {
    const video = source.video;
    if (!video || video.isCfr !== true || video.presentationStart !== 0
        || !(Number.isInteger(video.fpsNum) && video.fpsNum > 0)
        || !(Number.isInteger(video.fpsDen) && video.fpsDen > 0)
        || !(Number.isInteger(video.width) && video.width > 0)
        || !(Number.isInteger(video.height) && video.height > 0)) {
      throw new Error('media context 不满足 CFR 视频导出合同');
    }
  } else if (mediaContext.mediaType !== 'audio') {
    throw new Error('media context 媒体类型无效');
  }
  return compiledCutPlan;
}

function audioRateName(sampleRate) {
  return `${sampleRate / 1000}k`;
}

function sequenceAudioRateName(sampleRate) {
  const allowed = new Set([32000, 44100, 48000, 88200, 96000, 176400, 192000]);
  return audioRateName(allowed.has(sampleRate) ? sampleRate : 48000);
}

function buildFcpxml({
  mediaContext,
  compiledCutPlan,
  includeTitles = true,
  outputDirectory = '.',
}) {
  validateExportContract(mediaContext, compiledCutPlan);
  const sourcePath = path.resolve(mediaContext.sourcePath);
  if (path.resolve(mediaContext.exportPath) !== sourcePath) {
    throw new Error('FCPXML 只能引用 media context 的原始资产');
  }
  const source = mediaContext.source;
  const timebase = compiledCutPlan.timebase;
  const isAudio = mediaContext.mediaType === 'audio';
  const video = isAudio ? null : source.video;
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const escapedBaseName = escapeXml(baseName);
  const outputPath = path.resolve(outputDirectory, `${baseName}_cut.fcpxml`);
  const mediaUri = escapeXml(pathToFileURL(sourcePath).href);
  const outputUri = escapeXml(pathToFileURL(outputPath).href);
  const frameDuration = isAudio ? '1/30s' : `${video.fpsDen}/${video.fpsNum}s`;
  const width = isAudio ? 1920 : video.width;
  const height = isAudio ? 1080 : video.height;
  const rateName = audioRateName(source.sampleRate);
  const sequenceRateName = sequenceAudioRateName(source.sampleRate);
  const assetDuration = tickTime(compiledCutPlan.sourceDurationTicks, timebase);
  const selectedTitles = includeTitles ? compiledCutPlan.titleBlocks : [];
  const titlesByKeep = new Map();

  for (const [index, block] of selectedTitles.entries()) {
    if (!titlesByKeep.has(block.keepIndex)) titlesByKeep.set(block.keepIndex, []);
    const text = escapeXml(block.text);
    const styleId = `ts${index + 1}`;
    const durationTick = block.outputEndTick - block.outputStartTick;
    const keep = compiledCutPlan.keeps[block.keepIndex];
    // Nested titles use the parent clip's local clock. Rebase the compiled
    // output tick without changing its timeline position or quantizing again.
    const offsetTick = keep.sourceStartTick + block.outputStartTick - keep.outputStartTick;
    titlesByKeep.get(block.keepIndex).push(
      `              <title name="${text}" lane="1" offset="${tickTime(offsetTick, timebase)}" ref="r3" start="0/1s" duration="${tickTime(durationTick, timebase)}">\n`
      + `                <text><text-style ref="${styleId}">${text}</text-style></text>\n`
      + `                <text-style-def id="${styleId}"><text-style font="PingFang SC" fontSize="64" fontFace="Regular" fontColor="1 1 1 1" alignment="center">${text}</text-style></text-style-def>\n`
      + '                <adjust-transform position="0 -35" />\n'
      + '              </title>',
    );
  }

  const clips = compiledCutPlan.keeps.map((keep, keepIndex) => {
    const durationTick = keep.sourceEndTick - keep.sourceStartTick;
    const mediaAttrs = isAudio ? ' srcEnable="audio"' : ' format="r2"';
    const open = `            <asset-clip name="${escapedBaseName}" offset="${tickTime(keep.outputStartTick, timebase)}" ref="r1" start="${tickTime(keep.sourceStartTick, timebase)}" duration="${tickTime(durationTick, timebase)}"${mediaAttrs} audioRole="dialogue" tcFormat="NDF"`;
    const titles = titlesByKeep.get(keepIndex) || [];
    return titles.length
      ? `${open}>\n${titles.join('\n')}\n            </asset-clip>`
      : `${open} />`;
  }).join('\n');
  const totalOutputTick = compiledCutPlan.keeps.length
    ? compiledCutPlan.keeps[compiledCutPlan.keeps.length - 1].outputEndTick
    : 0;
  const assetFormat = isAudio ? '' : ' format="r2"';
  const sequenceFormat = ' format="r2"';
  const audioLayout = source.channels === 1 ? 'mono' : (source.channels === 2 ? 'stereo' : 'surround');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="r2" frameDuration="${frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)" />
    <asset id="r1" name="${escapedBaseName}" src="${mediaUri}" start="0/1s" duration="${assetDuration}"${assetFormat} hasAudio="1" hasVideo="${isAudio ? 0 : 1}" audioSources="1" audioChannels="${source.channels}" audioRate="${rateName}" />${selectedTitles.length ? `
    <effect id="r3" name="Basic Title" uid="${BASIC_TITLE_UID}" />` : ''}
  </resources>
  <library location="${outputUri}">
    <event name="${escapedBaseName}_剪辑" uid="${uuid()}">
      <project name="${escapedBaseName}_cut" uid="${uuid()}">
        <sequence duration="${tickTime(totalOutputTick, timebase)}"${sequenceFormat} tcStart="0/1s" tcFormat="NDF" audioLayout="${audioLayout}" audioRate="${sequenceRateName}">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

  return {
    xml,
    outputPath,
    finalKeeps: compiledCutPlan.keeps,
    baseName,
  };
}

module.exports = {
  buildFcpxml,
  tickTime,
  validateExportContract,
};
