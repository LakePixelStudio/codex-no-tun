'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildDesktopLaunchSpec,
  buildCliProxyEnv,
  generateWindowsNoTunVbs,
  createStandaloneNoTunLauncher
} = require('../src/launcher');
const { detectProxyConfig, readClashVergePortsReadOnly } = require('../src/discovery');
const { parseArgs } = require('../src/cli');

test('buildDesktopLaunchSpec & buildCliProxyEnv: 进程级变量隔离、剥离 ELECTRON_RUN_AS_NODE、保留回环直连', () => {
  const baseEnv = { PATH: 'C:\\Windows\\System32', ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' };
  const spec = buildDesktopLaunchSpec({
    proxyUrl: 'http://127.0.0.1:7897/',
    noProxy: 'custom.local',
    baseEnv,
    extraArgs: ['--profile', 'work']
  });
  assert.equal(spec.proxyUrl, 'http://127.0.0.1:7897');
  assert.equal(spec.env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(spec.env.ALL_PROXY, 'http://127.0.0.1:7897');
  assert.match(spec.env.NO_PROXY, /\blocalhost\b/);
  assert.match(spec.env.NO_PROXY, /\b127\.0\.0\.1\b/);
  assert.match(spec.env.NO_PROXY, /::1/);
  assert.match(spec.env.NO_PROXY, /custom\.local/);
  assert.equal(spec.env.NODE_USE_ENV_PROXY, '1');
  assert.equal('ELECTRON_RUN_AS_NODE' in spec.env, false);
  assert.equal(baseEnv.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(spec.args, [
    '--proxy-server=http://127.0.0.1:7897',
    `--proxy-bypass-list=${spec.chromiumBypass}`,
    '--profile',
    'work'
  ]);

  const cliEnv = buildCliProxyEnv(baseEnv, {
    proxyUrl: 'http://127.0.0.1:7897',
    nodeExe: 'C:\\Custom\\nodejs\\node.exe'
  });
  assert.equal('ELECTRON_RUN_AS_NODE' in cliEnv, false);
  assert.equal('NO_COLOR' in cliEnv, false);
  assert.equal(cliEnv.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.match(cliEnv.PATH, /^C:\\Custom\\nodejs;/);
});

test('generateWindowsNoTunVbs: 纯 ASCII 编码、中文及空格路径转义、防控制字符注入', () => {
  const vbs = generateWindowsNoTunVbs({
    exePath: "D:\\测试 目录\\Bob's Codex\\chatgpt-desktop.exe",
    proxyUrl: 'http://127.0.0.1:7897',
    noProxy: 'localhost,127.0.0.1,::1',
    preflightNodePath: 'D:\\测试 工具\\node.exe',
    preflightCliPath: 'D:\\测试 工具\\src\\cli.js'
  });
  assert.equal(/^[\x00-\x7F]+$/.test(vbs), true, 'VBS 必须为纯 ASCII');
  assert.match(vbs, /ChrW\(&H6d4b\) & ChrW\(&H8bd5\)/);
  assert.match(vbs, /shell\.Environment\("PROCESS"\)/);
  assert.match(vbs, /Win32_Process/);
  assert.match(vbs, /preflight/);
  assert.match(vbs, /WScript\.Quit 2/);
  assert.match(vbs, /WScript\.Quit 3/);

  assert.throws(() => generateWindowsNoTunVbs({
    exePath: 'C:\\a\r\nMsgBox 1',
    proxyUrl: 'http://127.0.0.1:7897'
  }), /控制字符/);
});

test('createStandaloneNoTunLauncher: 含中文和空格目录下生成 VBS 与真实 .lnk 快捷方式', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notun-测试 目录-'));
  try {
    const fakeExe = path.join(tempRoot, '应用 目录', 'chatgpt-desktop.exe');
    fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
    fs.writeFileSync(fakeExe, 'stub', 'utf8');

    const outDir = path.join(tempRoot, '输出 目录');
    const res = createStandaloneNoTunLauncher({
      exePath: fakeExe,
      iconPath: process.execPath,
      proxyUrl: 'http://127.0.0.1:7897',
      outDir,
      shortcutDir: outDir,
      shortcutName: 'Codex 免 TUN 测试'
    });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(res.launcherPath), true);
    assert.equal(fs.existsSync(res.shortcutPath), true);
    assert.equal(res.shortcutPath.endsWith('Codex 免 TUN 测试.lnk'), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseArgs: CLI 包装参数与透传参数顺序（含中文、空格与嵌套选项）', () => {
  const p1 = parseArgs(['cli', '--proxy', 'http://127.0.0.1:7897', 'exec', '-m', 'gpt-5.1-codex', '你好 世界']);
  assert.equal(p1.cmd, 'cli');
  assert.equal(p1.flags.proxy, 'http://127.0.0.1:7897');
  assert.deepEqual(p1.passthrough, ['exec', '-m', 'gpt-5.1-codex', '你好 世界']);

  const p2 = parseArgs(['cli', '--proxy', 'http://127.0.0.1:7897', '--', '--config', 'model="o3"', '测试']);
  assert.equal(p2.cmd, 'cli');
  assert.deepEqual(p2.passthrough, ['--config', 'model="o3"', '测试']);
});

test('discovery: fail-closed 配置探测与 Clash 脱敏读取（不读取 secret）', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notun-disc-'));
  try {
    const cfgPath = path.join(tempRoot, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false, proxyUrl: 'http://127.0.0.1:7897' }), 'utf8');
    const disabled = detectProxyConfig({ candidates: [cfgPath] });
    assert.equal(disabled.detected, true);
    assert.equal(disabled.enabled, false);

    const clashDir = path.join(tempRoot, 'clash');
    fs.mkdirSync(clashDir, { recursive: true });
    fs.writeFileSync(path.join(clashDir, 'config.yaml'), [
      'mixed-port: 7897',
      'secret: "super-secret-do-not-read"',
      'tun:',
      '  enable: false'
    ].join('\n'), 'utf8');
    const clashInfo = readClashVergePortsReadOnly({ clashDirs: [clashDir] });
    assert.equal(clashInfo.ports.length, 1);
    assert.equal(clashInfo.ports[0].port, 7897);
    assert.equal(clashInfo.tunEnabledInConfig, false);
    assert.equal(JSON.stringify(clashInfo).includes('super-secret'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
