'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  previewTomlKeyChange,
  applyTomlKeyChange,
  restoreTomlKeyChange
} = require('../src/optional-config');

test('optional-config: 单键合并、备份、用户后续修改在恢复时完整保留', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notun-cfg-'));
  try {
    const tomlPath = path.join(tempRoot, 'config.toml');
    const stateFile = path.join(tempRoot, 'state.json');
    const backupDir = path.join(tempRoot, 'backups');

    const initialToml = [
      '# User comment preserved',
      'model = "gpt-5.1-codex"',
      '',
      '[features]',
      'memories = true',
      ''
    ].join('\n');
    fs.writeFileSync(tomlPath, initialToml, 'utf8');

    // 1. 预览不落盘
    const prev = previewTomlKeyChange(tomlPath, 'features', 'respect_system_proxy', false);
    assert.equal(prev.action, 'inserted_in_section');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), initialToml);

    // 2. 显式写入并备份
    const applied = applyTomlKeyChange(tomlPath, 'features', 'respect_system_proxy', false, { stateFile, backupDir });
    assert.equal(applied.ok, true);
    assert.equal(fs.existsSync(applied.backupPath), true);
    const afterApply = fs.readFileSync(tomlPath, 'utf8');
    assert.match(afterApply, /respect_system_proxy = false/);
    assert.match(afterApply, /memories = true/);

    // 3. 模拟用户后续对 config.toml 做了其他修改
    const userEdited = afterApply + 'user_new_flag = true\n\n[desktop]\nsansFontSize = 15\n';
    fs.writeFileSync(tomlPath, userEdited, 'utf8');

    // 4. 恢复时仅移除工具添加的单键，保留用户后续全部修改
    const restored = restoreTomlKeyChange(tomlPath, { stateFile });
    assert.equal(restored.ok, true);
    assert.equal(restored.outcome, 'removed_added_key');
    const finalToml = fs.readFileSync(tomlPath, 'utf8');
    assert.doesNotMatch(finalToml, /respect_system_proxy/);
    assert.match(finalToml, /user_new_flag = true/);
    assert.match(finalToml, /sansFontSize = 15/);
    assert.match(finalToml, /# User comment preserved/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('optional-config: 原先已存在该键时恢复原值且保留其他修改', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notun-cfg2-'));
  try {
    const tomlPath = path.join(tempRoot, 'config.toml');
    const stateFile = path.join(tempRoot, 'state.json');
    const backupDir = path.join(tempRoot, 'backups');

    fs.writeFileSync(tomlPath, '[features]\nrespect_system_proxy = true\nmemories = true\n', 'utf8');
    applyTomlKeyChange(tomlPath, 'features', 'respect_system_proxy', false, { stateFile, backupDir });
    assert.match(fs.readFileSync(tomlPath, 'utf8'), /respect_system_proxy = false/);

    fs.appendFileSync(tomlPath, '[windows]\nsandbox = "elevated"\n', 'utf8');

    const restored = restoreTomlKeyChange(tomlPath, { stateFile });
    assert.equal(restored.ok, true);
    assert.equal(restored.outcome, 'restored_previous_value');
    const finalToml = fs.readFileSync(tomlPath, 'utf8');
    assert.match(finalToml, /respect_system_proxy = true/);
    assert.match(finalToml, /sandbox = "elevated"/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('optional-config: 根级数值键 model_auto_compact_token_limit 合并与恢复并保留后续修改', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notun-rootcfg-'));
  try {
    const tomlPath = path.join(tempRoot, 'config.toml');
    const stateFile = path.join(tempRoot, 'root-state.json');
    const backupDir = path.join(tempRoot, 'backups');

    fs.writeFileSync(tomlPath, 'model = "gpt-6.2-sol"\n\n[features]\nmemories = true\n', 'utf8');
    const applied = applyTomlKeyChange(tomlPath, '', 'model_auto_compact_token_limit', 120000, { stateFile, backupDir });
    assert.equal(applied.ok, true);
    const afterApply = fs.readFileSync(tomlPath, 'utf8');
    assert.match(afterApply, /^model_auto_compact_token_limit = 120000/m);
    assert.match(afterApply, /\[features\]\nmemories = true/);

    fs.appendFileSync(tomlPath, 'user_extra = "keep-me"\n', 'utf8');
    const restored = restoreTomlKeyChange(tomlPath, { stateFile });
    assert.equal(restored.ok, true);
    assert.equal(restored.outcome, 'removed_added_key');
    const finalToml = fs.readFileSync(tomlPath, 'utf8');
    assert.doesNotMatch(finalToml, /model_auto_compact_token_limit/);
    assert.match(finalToml, /user_extra = "keep-me"/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
