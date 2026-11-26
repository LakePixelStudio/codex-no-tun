'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  COMPACT_PRESETS,
  parseCompactLimitInput,
  getCompactLimitStatus,
  applyCompactLimitPreset,
  restoreCompactLimit
} = require('../src/compact-presets');

test('parseCompactLimitInput: 支持三档名称、简写、数字、恢复与越界拒绝', () => {
  assert.deepEqual(parseCompactLimitInput('aggressive'), { ok: true, action: 'set', presetId: 'aggressive', tokens: 120000 });
  assert.deepEqual(parseCompactLimitInput('120k'), { ok: true, action: 'set', presetId: 'aggressive', tokens: 120000 });
  assert.deepEqual(parseCompactLimitInput('balanced'), { ok: true, action: 'set', presetId: 'balanced', tokens: 180000 });
  assert.deepEqual(parseCompactLimitInput('180k'), { ok: true, action: 'set', presetId: 'balanced', tokens: 180000 });
  assert.deepEqual(parseCompactLimitInput('relaxed'), { ok: true, action: 'set', presetId: 'relaxed', tokens: 250000 });
  assert.deepEqual(parseCompactLimitInput('250k'), { ok: true, action: 'set', presetId: 'relaxed', tokens: 250000 });
  assert.deepEqual(parseCompactLimitInput('150000'), { ok: true, action: 'set', presetId: 'custom', tokens: 150000 });
  assert.deepEqual(parseCompactLimitInput('restore'), { ok: true, action: 'restore', presetId: null, tokens: null });

  assert.equal(parseCompactLimitInput('').ok, false);
  assert.equal(parseCompactLimitInput('5000').ok, false);
  assert.equal(parseCompactLimitInput('900000').ok, false);
  assert.equal(parseCompactLimitInput('invalid').ok, false);
});

test('applyCompactLimitPreset & getCompactLimitStatus & restoreCompactLimit: 三档切换与可逆还原', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compact-test-'));
  try {
    const configPath = path.join(tempRoot, 'config.toml');
    const stateFile = path.join(tempRoot, 'state.json');
    const backupDir = path.join(tempRoot, 'backups');

    fs.writeFileSync(configPath, 'model = "gpt-6.2-sol"\n\n[features]\nmemories = true\n', 'utf8');

    const s0 = getCompactLimitStatus({ configPath });
    assert.equal(s0.configured, false);
    assert.equal(s0.presetId, 'default');

    // 1. 设为 balanced (180,000)
    const r1 = applyCompactLimitPreset('balanced', { configPath, stateFile, backupDir });
    assert.equal(r1.ok, true);
    assert.equal(r1.tokens, COMPACT_PRESETS.balanced.tokens);
    const s1 = getCompactLimitStatus({ configPath });
    assert.equal(s1.configured, true);
    assert.equal(s1.tokens, 180000);
    assert.equal(s1.presetId, 'balanced');

    // 2. 切换为 aggressive (120,000) 再切换为 relaxed (250,000)
    applyCompactLimitPreset('aggressive', { configPath, stateFile, backupDir });
    assert.equal(getCompactLimitStatus({ configPath }).presetId, 'aggressive');
    applyCompactLimitPreset('relaxed', { configPath, stateFile, backupDir });
    assert.equal(getCompactLimitStatus({ configPath }).presetId, 'relaxed');

    // 模拟用户后续修改其他配置
    fs.appendFileSync(configPath, 'user_keep = true\n', 'utf8');

    // 3. 恢复默认后保留用户后续修改
    const restored = restoreCompactLimit({ configPath, stateFile });
    assert.equal(restored.ok, true);
    assert.equal(getCompactLimitStatus({ configPath }).configured, false);
    assert.match(fs.readFileSync(configPath, 'utf8'), /user_keep = true/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
