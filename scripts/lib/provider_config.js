'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENGINES = ['flash', 'v3-standard'];
const PLACEHOLDERS = ['your_api_key_here', 'your-api-key', 'xxx', '<your_api_key>'];

function validateKey(key, source) {
  if (!key.trim()) return { state: 'missing_key', source };
  if (PLACEHOLDERS.includes(key.trim().toLowerCase())) return { state: 'placeholder', source };
  // Both Node headers and curl receive the same ASCII bytes. Reject newlines and
  // other controls instead of allowing shell command substitution to alter them.
  if (/[^\x09\x20-\x7e]/.test(key)) return { state: 'invalid_key', source };
  return { state: 'ok', key, source };
}

function parseKeyFromFile(file) {
  const values = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.match(/^[\t ]*VOLCENGINE_API_KEY[\t ]*=[\t ]*(.*)$/))
    .filter(Boolean).map(match => match[1].trim());
  if (values.length > 1) return { state: 'duplicate_key', source: file };
  if (!values.length || !values[0]) return { state: 'missing_key', source: file };
  let key = values[0];
  if (key[0] === '"' || key[0] === "'") {
    if (key.length < 2 || key.at(-1) !== key[0]) return { state: 'invalid_quotes', source: file };
    key = key.slice(1, -1);
  }
  return validateKey(key, file);
}

function readProviderConfig({ skillDir, env = process.env }) {
  if (env.VOLCENGINE_API_KEY) return validateKey(env.VOLCENGINE_API_KEY, '环境变量');
  const candidates = [env.VOLCENGINE_ENV_FILE, path.join(skillDir, '.env'), path.join(path.dirname(skillDir), '.env')].filter(Boolean);
  let sawFile = false;
  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file)) continue;
    sawFile = true;
    let result;
    try { result = parseKeyFromFile(file); }
    catch (_) { return { state: 'unreadable_file', source: file }; }
    if (result.state !== 'missing_key') return result;
  }
  return { state: sawFile ? 'missing_key' : 'missing_file' };
}

function configError(result) {
  const messages = {
    missing_file: '没找到 VOLCENGINE_API_KEY（环境变量和 .env 都没有）',
    missing_key: '.env 里缺少非空 VOLCENGINE_API_KEY',
    placeholder: 'VOLCENGINE_API_KEY 仍是占位符',
    duplicate_key: '.env 里重复定义 VOLCENGINE_API_KEY，请只保留一项',
    invalid_quotes: 'VOLCENGINE_API_KEY 的引号未成对闭合',
    invalid_key: 'VOLCENGINE_API_KEY 包含换行、控制字符或非 ASCII 字符',
    unreadable_file: '无法读取 API Key 配置文件',
  };
  return `${messages[result.state] || 'API Key 配置无效'}${result.source ? `（${result.source}）` : ''}`;
}

function readSetupCapabilities(skillDir) {
  try {
    const setup = JSON.parse(fs.readFileSync(path.join(skillDir, '.setup_done'), 'utf8'));
    if (setup.version !== 1 || !Array.isArray(setup.availableEngines)
        || !setup.availableEngines.length || setup.availableEngines.some(engine => !ENGINES.includes(engine))) return null;
    return ENGINES.filter(engine => setup.availableEngines.includes(engine));
  } catch (_) {
    // Timestamp-only markers predate capability discovery; keep their auto rule.
    return null;
  }
}

function recommendedEngine(availableEngines) {
  return availableEngines.length === 2 ? 'auto' : availableEngines[0] || null;
}

function assertEngineAvailable(engine, availableEngines) {
  if (!ENGINES.includes(engine)) throw new Error(`未知引擎: ${engine}`);
  if (availableEngines && !availableEngines.includes(engine)) {
    throw new Error(`当前 setup 未确认 ${engine} 可用；请使用 ${availableEngines.map(value => `--${value}`).join(' / ')}，或开通资源后运行 doctor.js --force`);
  }
  return engine;
}

function selectConfiguredEngine({ requestedEngine, lastEngine, skillDir }) {
  const availableEngines = readSetupCapabilities(skillDir);
  if (requestedEngine !== 'auto') return assertEngineAvailable(requestedEngine, availableEngines);
  if (availableEngines && availableEngines.length === 1) return availableEngines[0];
  return lastEngine === 'flash' ? 'v3-standard' : 'flash';
}

if (require.main === module) {
  const skillDir = process.argv[2] || path.resolve(__dirname, '../..');
  const result = readProviderConfig({ skillDir });
  if (result.state === 'ok') process.stdout.write(result.key);
  else {
    console.error(`❌ ${configError(result)}`);
    console.error(`   在 ${path.join(skillDir, '.env')} 配置 VOLCENGINE_API_KEY，或使用环境变量。`);
    process.exitCode = 1;
  }
}

module.exports = { readProviderConfig, configError, readSetupCapabilities, recommendedEngine, assertEngineAvailable, selectConfiguredEngine };
