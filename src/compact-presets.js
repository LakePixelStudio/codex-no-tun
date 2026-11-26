'use strict';
/**
 * 3-tier auto-compaction presets for Codex `model_auto_compact_token_limit`.
 * Lets users balance context retention vs. avoiding oversized WebSocket/HTTP payloads (os error 10053).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyTomlKeyChange, restoreTomlKeyChange } = require('./optional-config');

const MIN_COMPACT_TOKENS = 20000;
const MAX_COMPACT_TOKENS = 450000;

const COMPACT_PRESETS = {
  aggressive: {
    id: 'aggressive',
    label: '激进抗断连',
    tokens: 120000,
    ratioHint: '约 24% (以 500k 窗口计)',
    description: '更早触发自动压缩，最不容易因单轮请求体过大触发 10053 断连'
  },
  balanced: {
    id: 'balanced',
    label: '平衡推荐',
    tokens: 180000,
    ratioHint: '约 36% (以 500k 窗口计)',
    description: '推荐：长对话用不到一半自动压缩，兼顾上下文完整与连接稳定'
  },
  relaxed: {
    id: 'relaxed',
    label: '较宽松',
    tokens: 250000,
    ratioHint: '约 50% (以 500k 窗口计)',
    description: '保留更长原始对话记录，含截图或大工具输出时需留意体积'
  }
};

function getCompactStateFile(options = {}) {
  if (options.stateFile) return path.resolve(options.stateFile);
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return path.join(localAppData, 'CodexNoTun', 'config-toml-root-model_auto_compact_token_limit.json');
}

function getCodexTomlPath(options = {}) {
  if (options.configPath) return path.resolve(options.configPath);
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return path.join(codexHome, 'config.toml');
}

function parseCompactLimitInput(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) {
    return { ok: false, error: '未提供档位或数值（可选：aggressive / balanced / relaxed / 120k / 180k / 250k / restore）' };
  }
  if (s === 'restore' || s === 'default' || s === 'reset') {
    return { ok: true, action: 'restore', presetId: null, tokens: null };
  }
  if (s === '1' || s === 'aggressive' || s === '激进' || s === '120k') {
    return { ok: true, action: 'set', presetId: 'aggressive', tokens: COMPACT_PRESETS.aggressive.tokens };
  }
  if (s === '2' || s === 'balanced' || s === '推荐' || s === '平衡' || s === '180k') {
    return { ok: true, action: 'set', presetId: 'balanced', tokens: COMPACT_PRESETS.balanced.tokens };
  }
  if (s === '3' || s === 'relaxed' || s === '宽松' || s === '250k') {
    return { ok: true, action: 'set', presetId: 'relaxed', tokens: COMPACT_PRESETS.relaxed.tokens };
  }
  const normalizedNum = s.endsWith('k') && /^\d+k$/.test(s)
    ? Number(s.slice(0, -1)) * 1000
    : (/^\d+$/.test(s) ? Number(s) : NaN);
  if (!Number.isInteger(normalizedNum) || normalizedNum < MIN_COMPACT_TOKENS || normalizedNum > MAX_COMPACT_TOKENS) {
    return {
      ok: false,
      error: `无效的压缩阈值 "${raw}"：请输入档位 (aggressive/balanced/relaxed) 或 ${MIN_COMPACT_TOKENS}~${MAX_COMPACT_TOKENS} 之间的整数`
    };
  }
  const matched = Object.values(COMPACT_PRESETS).find((p) => p.tokens === normalizedNum);
  return {
    ok: true,
    action: 'set',
    presetId: matched ? matched.id : 'custom',
    tokens: normalizedNum
  };
}

function getCompactLimitStatus(options = {}) {
  const fsImpl = options.fs || fs;
  const tomlPath = getCodexTomlPath(options);
  let currentTokens = null;

  if (fsImpl.existsSync(tomlPath)) {
    const content = fsImpl.readFileSync(tomlPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      if (/^\[[^\]]+\]$/.test(line)) break;
      const m = line.match(/^model_auto_compact_token_limit\s*=\s*(\d+)\s*$/);
      if (m) {
        currentTokens = Number(m[1]);
        break;
      }
    }
  }

  const matchedPreset = currentTokens !== null
    ? (Object.values(COMPACT_PRESETS).find((p) => p.tokens === currentTokens) || null)
    : null;

  return {
    configPath: tomlPath,
    configured: currentTokens !== null,
    tokens: currentTokens,
    presetId: matchedPreset ? matchedPreset.id : (currentTokens !== null ? 'custom' : 'default'),
    label: matchedPreset ? matchedPreset.label : (currentTokens !== null ? '自定义阈值' : '官方默认 (~90%)'),
    presets: Object.values(COMPACT_PRESETS)
  };
}

function applyCompactLimitPreset(rawInput, options = {}) {
  const parsed = parseCompactLimitInput(rawInput);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const tomlPath = getCodexTomlPath(options);
  const stateFile = getCompactStateFile(options);

  if (parsed.action === 'restore') {
    const res = restoreTomlKeyChange(tomlPath, { fs: options.fs, stateFile });
    return { ...res, action: 'restore', tokens: null, presetId: 'default' };
  }

  const res = applyTomlKeyChange(tomlPath, '', 'model_auto_compact_token_limit', parsed.tokens, {
    fs: options.fs,
    stateFile,
    backupDir: options.backupDir
  });
  const preset = COMPACT_PRESETS[parsed.presetId] || null;
  return {
    ...res,
    action: 'set',
    tokens: parsed.tokens,
    presetId: parsed.presetId,
    label: preset ? preset.label : '自定义阈值'
  };
}

function restoreCompactLimit(options = {}) {
  const tomlPath = getCodexTomlPath(options);
  const stateFile = getCompactStateFile(options);
  return restoreTomlKeyChange(tomlPath, { fs: options.fs, stateFile });
}

module.exports = {
  MIN_COMPACT_TOKENS,
  MAX_COMPACT_TOKENS,
  COMPACT_PRESETS,
  getCompactStateFile,
  getCodexTomlPath,
  parseCompactLimitInput,
  getCompactLimitStatus,
  applyCompactLimitPreset,
  restoreCompactLimit
};
