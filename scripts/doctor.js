#!/usr/bin/env node
/*
 * 首次使用环境自检（跨平台 Win / macOS / Linux）
 *
 * 用法:
 *   node doctor.js            正常自检；至少一个资源可用则记录 setup 能力
 *   node doctor.js --force    兼容参数；显式执行 doctor 总是重新检测
 *   node doctor.js --json     额外在末尾输出一行 JSON（给上层程序解析）
 *
 * 退出码: 0 = 依赖、凭证及至少一个资源通过；1 = 尚不可用
 *
 * 设计要点:
 *   - 三层检查：系统依赖 → 凭证文件 → 联网实测 key+两个资源
 *   - 第三层用一秒有效静音 WAV 探测，必须 HTTP 2xx 且明确完成/接受
 *     flash 接受 20000000 或预期的静音完成 20000003；standard submit 仅接受 20000000
 *   - 就绪后写 SKILL_DIR/.setup_done，保留已验证资源与推荐参数
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readProviderConfig, configError, recommendedEngine } = require('./lib/provider_config');

const isWin = process.platform === 'win32';
const SKILL_DIR = path.resolve(__dirname, '..');
const SENTINEL = path.join(SKILL_DIR, '.setup_done');
const RECOMMEND_ENV = path.join(SKILL_DIR, '.env');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

// ── 终端着色（Windows 新终端也支持 ANSI）─────────────────
const useColor = process.stdout.isTTY;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  green: s => paint('32', s), red: s => paint('31', s),
  yellow: s => paint('33', s), dim: s => paint('2', s),
  bold: s => paint('1', s), cyan: s => paint('36', s),
};
const OK = C.green('✅'), BAD = C.red('❌'), WARN = C.yellow('⚠️ ');

function showCapabilities(availableEngines, recommendation) {
  console.log(C.dim(`   已确认资源：${availableEngines.join(' / ')}；转录参数：--${recommendation}`));
}

// ── 自愈：补回 .sh 执行位 ────────────────────────────────
// git clone / 解压后 shell 脚本常丢失可执行位，导致 "permission denied"。
// 主流程已统一用 `bash <script>` 调用（不依赖此位），这里再兜底，方便直接 ./xxx.sh 调用。
function fixShebangs() {
  if (isWin) return; // Windows 无执行位概念
  const dir = path.join(SKILL_DIR, 'scripts');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.sh')) continue;
      try { fs.chmodSync(path.join(dir, f), 0o755); } catch (_) {}
    }
  } catch (_) {}
}

// ── 第一层：系统依赖 ─────────────────────────────────────
function probe(cmd, arg) {
  try {
    const r = spawnSync(cmd, [arg], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch (_) { return false; }
}

const winHint = (mac, win) => (isWin ? win : mac);

const DEPS = [
  {
    name: 'ffmpeg', ok: () => probe('ffmpeg', '-version'),
    why: '从视频里抽音频',
    hint: winHint('brew install ffmpeg',
      'winget install Gyan.FFmpeg   或   scoop install ffmpeg'),
  },
  {
    name: 'ffprobe', ok: () => probe('ffprobe', '-version'),
    why: '校验源媒体与审核音频的时间信息',
    hint: winHint('brew install ffmpeg',
      'winget install Gyan.FFmpeg   或   scoop install ffmpeg'),
  },
  {
    name: 'node', ok: () => probe('node', '-v'),
    why: '跑本 Skill 的所有脚本',
    hint: winHint('brew install node', 'winget install OpenJS.NodeJS'),
  },
  {
    name: 'python3', ok: () => probe('python3', '--version'),
    why: '音频 base64 编码 / 结果解析',
    hint: winHint('brew install python',
      'winget install Python.Python.3.12   （装完确保 python3 在 PATH）'),
  },
  {
    name: 'curl', ok: () => probe('curl', '--version'),
    why: '调用火山引擎转录接口',
    hint: winHint('macOS 自带，通常无需安装',
      'Windows 10+ 自带；若缺失：winget install cURL.cURL'),
  },
];

function checkDeps() {
  console.log(C.bold('\n[1/3] 系统依赖'));
  const missing = [];
  for (const d of DEPS) {
    const ok = d.ok();
    console.log(`  ${ok ? OK : BAD} ${d.name.padEnd(8)} ${C.dim(d.why)}`);
    if (!ok) { console.log(`        ${C.yellow('安装：')}${d.hint}`); missing.push(d.name); }
  }
  return missing;
}

// ── 第二层：凭证文件 ─────────────────────────────────────
function checkEnv() {
  console.log(C.bold('\n[2/3] API Key 凭证'));
  const r = readProviderConfig({ skillDir: SKILL_DIR });
  if (r.state === 'ok') {
    console.log(`  ${OK} 找到 VOLCENGINE_API_KEY（来自 ${r.source}）`);
    return r;
  }
  console.log(`  ${BAD} ${configError(r)}`);
  console.log(C.yellow(`   方式一(推荐)：在 ${RECOMMEND_ENV} 写一行  VOLCENGINE_API_KEY=你的key`));
  console.log(C.yellow('   方式二：export VOLCENGINE_API_KEY=你的key'));
  console.log(C.yellow('   key 申请：https://console.volcengine.com/speech/new/overview'));
  return r;
}

// ── 第三层：联网实测 key + 两个资源 ──────────────────────
// 有效的一秒单声道 16kHz PCM 静音 WAV；空音频/格式错误不能被当成可用证据。
function probeAudio() {
  const sampleRate = 16000;
  const audio = Buffer.alloc(44 + sampleRate * 2);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  return audio.toString('base64');
}

function ping(apiKey, resourceId, urlPath) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      user: { uid: 'doctor' },
      audio: { data: probeAudio(), format: 'wav' },
      request: { model_name: 'bigmodel' },
    });
    const req = https.request({
      hostname: 'openspeech.bytedance.com',
      path: urlPath, method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const status = res.headers['x-api-status-code'] || '';
      const message = res.headers['x-api-message'] || '';
      res.on('data', () => {});
      res.on('end', () => resolve({ http: res.statusCode, status, message }));
      res.on('error', e => resolve({ status: '', netErr: e.message }));
      res.on('aborted', () => resolve({ status: '', netErr: '响应中断' }));
    });
    req.on('error', e => resolve({ status: '', message: '', netErr: e.message }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ status: '', message: '', netErr: '超时' }); });
    req.write(body);
    req.end();
  });
}

function interpret(name, r, acceptSilentCompletion = false) {
  if (r.netErr) {
    console.log(`  ${WARN} ${name}：无法连接火山引擎（${r.netErr}）— 检查网络后重试`);
    return 'unknown';
  }
  if (r.status === '45000010') {
    console.log(`  ${BAD} ${name}：API Key 无效（确认来自「新版」控制台）`);
    return 'badkey';
  }
  if (r.status === '45000151') {
    console.log(`  ${WARN} ${name}：探测未通过（45000151：音频格式不正确），尚未确认可用`);
    return 'unknown';
  }
  // Official flash contract: 20000003 means silent audio, distinct from empty
  // audio (45000002) and invalid format (45000151). For our known silent WAV,
  // this is the expected terminal processing result, not transcript success.
  // https://www.volcengine.com/docs/6561/1631584?lang=zh
  const silenceCompleted = acceptSilentCompletion && r.status === '20000003';
  if (!(r.http >= 200 && r.http < 300) || (r.status !== '20000000' && !silenceCompleted)) {
    console.log(`  ${WARN} ${name}：尚未确认可用（HTTP ${r.http || '未返回'}，业务状态 ${r.status || '未返回'}），请稍后重试`);
    return 'unknown';
  }
  console.log(`  ${OK} ${name}：${silenceCompleted ? '静音探测已完成（20000003），资源可用' : '可用'}`);
  return 'ok';
}

async function checkResources(apiKey) {
  console.log(C.bold('\n[3/3] 联网实测（key + 两个资源）'));
  const [flash, std] = await Promise.all([
    ping(apiKey, 'volc.bigasr.auc_turbo', '/api/v3/auc/bigmodel/recognize/flash'),
    ping(apiKey, 'volc.bigasr.auc', '/api/v3/auc/bigmodel/submit'),
  ]);
  const rf = interpret('极速版 auc_turbo', flash, true);
  const rs = interpret('标准版 auc', std);
  if (rf === 'badkey' || rs === 'badkey') {
    console.log(C.dim('   两个引擎共用同一个 key；key 无效会一起失败。'));
  }
  if ((rf === 'ok') !== (rs === 'ok')) {
    console.log(C.dim('   一个资源通过即可完成 setup；auto 使用唯一已确认资源。'));
  }
  return { flash: rf, std: rs };
}

// ── 主流程 ───────────────────────────────────────────────
(async () => {
  console.log(C.cyan(C.bold('🩺 speech-roughcut · 环境自检')) + C.dim(`  (${process.platform})`));

  fixShebangs();
  const missingDeps = checkDeps();
  const env = checkEnv();

  let res = null;
  const canPing = env.state === 'ok';
  if (canPing) {
    res = await checkResources(env.key);
  } else {
    console.log(C.bold('\n[3/3] 联网实测'));
    console.log(`  ${C.dim('跳过 — 先把上面的 API Key 配好再测')}`);
  }

  const depsOk = missingDeps.length === 0;
  const envOk = env.state === 'ok';
  const availableEngines = [];
  if (res && res.flash === 'ok') availableEngines.push('flash');
  if (res && res.std === 'ok') availableEngines.push('v3-standard');
  const recommendation = recommendedEngine(availableEngines);
  const resOk = availableEngines.length > 0;
  const allGreen = depsOk && envOk && resOk;

  console.log(C.bold('\n── 结论 ' + '─'.repeat(28)));
  if (allGreen) {
    fs.writeFileSync(SENTINEL, JSON.stringify({
      version: 1, configuredAt: new Date().toISOString(), availableEngines, recommendedEngine: recommendation,
    }, null, 2) + '\n');
    console.log(`${OK} ${C.green('已可使用！')}已记录当前资源能力。`);
    showCapabilities(availableEngines, recommendation);
    console.log(C.dim(`   标记文件：${SENTINEL}`));
  } else {
    const todo = [];
    if (!depsOk) todo.push(`装依赖：${missingDeps.join(' / ')}`);
    if (!envOk) todo.push('配置 API Key 到 .env');
    if (envOk && !resOk) todo.push('根据上方状态检查 key、资源或网络，至少确认一个资源可用');
    console.log(`${BAD} ${C.red('还差几步：')}`);
    todo.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
    console.log(C.dim('   修好后重跑：node doctor.js'));
  }

  if (JSON_OUT) {
    console.log('__DOCTOR_JSON__ ' + JSON.stringify({
      allGreen, ready: allGreen, depsOk, missingDeps, envState: env.state,
      availableEngines, recommendedEngine: recommendation, recommendedFlag: recommendation ? `--${recommendation}` : null,
      flash: res && res.flash, std: res && res.std, platform: process.platform,
    }));
  }
  process.exit(allGreen ? 0 : 1);
})();
