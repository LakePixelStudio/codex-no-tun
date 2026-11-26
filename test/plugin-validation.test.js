'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectCodexInstallations } = require('../src/discovery');
const { scanDirectoryForLeaks } = require('../scripts/build-release-zip');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_ROOT = path.join(PROJECT_ROOT, 'plugin-marketplace');

test('plugin-validation: manifest 结构、Skill frontmatter、隐私审计及隔离 CODEX_HOME 下的真实安装/卸载验证', () => {
  const mpPath = path.join(MARKETPLACE_ROOT, '.agents', 'plugins', 'marketplace.json');
  const pluginDir = path.join(MARKETPLACE_ROOT, 'plugins', 'codex-no-tun');
  const pluginJsonPath = path.join(pluginDir, '.codex-plugin', 'plugin.json');

  assert.equal(fs.existsSync(mpPath), true);
  assert.equal(fs.existsSync(pluginJsonPath), true);

  const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  assert.equal(mp.name, 'codex-no-tun-local');
  assert.equal(mp.plugins[0].name, 'codex-no-tun');
  assert.equal(mp.plugins[0].source.path, './plugins/codex-no-tun');

  const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  assert.equal(pj.name, 'codex-no-tun');
  assert.equal(pj.version, '0.4.0');
  assert.equal(pj.skills, './skills/');
  assert.equal(Array.isArray(pj.interface?.defaultPrompt), true);
  assert.ok(pj.interface.defaultPrompt.length <= 3, 'Codex manifest 最多支持 3 条 defaultPrompt');
  assert.equal(fs.existsSync(path.join(pluginDir, 'assets', 'icon.svg')), true);
  assert.equal(fs.existsSync(path.join(pluginDir, 'assets', 'icon-dark.svg')), true);

  // 确保可发布源码与插件目录不含任何硬编码的本机隐私路径
  for (const sub of ['src', 'plugin-marketplace', 'scripts', 'README.md', 'AGENTS.md']) {
    const target = path.join(PROJECT_ROOT, sub);
    if (fs.statSync(target).isDirectory()) {
      assert.deepEqual(scanDirectoryForLeaks(target), [], `${sub} 不得包含硬编码个人路径`);
    } else {
      assert.deepEqual(
        require('../scripts/build-release-zip').scanDirectoryForLeaks(path.dirname(target)).filter((h) => h.file === path.basename(target)),
        [],
        `${sub} 不得包含硬编码个人路径`
      );
    }
  }

  for (const skillName of ['check-proxy', 'proxy-status', 'launcher-guide', 'fix-disconnect']) {
    const skillMd = path.join(pluginDir, 'skills', skillName, 'SKILL.md');
    assert.equal(fs.existsSync(skillMd), true, `缺少 ${skillName}/SKILL.md`);
    const content = fs.readFileSync(skillMd, 'utf8');
    assert.match(content, /^---\r?\nname:\s*.+\r?\ndescription:\s*.+/);
  }

  const installs = detectCodexInstallations();
  const codexBin = installs.cli.bundledCliExe;
  if (!codexBin) return;

  // 在隔离的临时 CODEX_HOME 中验证真实 `codex plugin marketplace add` / `plugin add` / `plugin list` / `plugin remove`
  const tempHome = fs.mkdtempSync(path.join(PROJECT_ROOT, '.tmp-plugin-home-'));
  try {
    const isoEnv = { ...process.env, CODEX_HOME: tempHome };
    execFileSync(codexBin, ['plugin', 'marketplace', 'add', MARKETPLACE_ROOT, '--json'], {
      env: isoEnv,
      encoding: 'utf8',
      windowsHide: true
    });
    const listOut = execFileSync(codexBin, ['plugin', 'list'], {
      env: isoEnv,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.match(listOut, /codex-no-tun@codex-no-tun-local/);

    const addOut = execFileSync(codexBin, ['plugin', 'add', 'codex-no-tun@codex-no-tun-local', '--json'], {
      env: isoEnv,
      encoding: 'utf8',
      windowsHide: true
    });
    const addJson = JSON.parse(addOut);
    assert.equal(addJson.name, 'codex-no-tun');
    assert.equal(addJson.pluginId, 'codex-no-tun@codex-no-tun-local');

    const remOut = execFileSync(codexBin, ['plugin', 'remove', 'codex-no-tun@codex-no-tun-local', '--json'], {
      env: isoEnv,
      encoding: 'utf8',
      windowsHide: true
    });
    const remJson = JSON.parse(remOut);
    assert.equal(remJson.name, 'codex-no-tun');
    assert.equal(remJson.pluginId, 'codex-no-tun@codex-no-tun-local');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
