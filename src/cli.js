'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const {
  DEFAULT_NO_PROXY,
  parseAndValidateProxyUrl,
  ensureLoopbackNoProxy,
  redactProxyUrl,
  checkProxyHealth
} = require('./proxy-core');
const {
  getConfigCandidatePaths,
  detectProxyConfig,
  recordToolkitRoot,
  saveProxyConfig,
  discoverLocalProxyCandidates,
  detectCodexInstallations,
  inspectEnvironmentState,
  queryClashConnectionsSanitized
} = require('./discovery');
const {
  COMPACT_PRESETS,
  getCompactLimitStatus,
  applyCompactLimitPreset,
  restoreCompactLimit
} = require('./compact-presets');
const {
  buildDesktopLaunchSpec,
  buildCliProxyEnv,
  createStandaloneNoTunLauncher
} = require('./launcher');
const {
  previewTomlKeyChange,
  applyTomlKeyChange,
  restoreTomlKeyChange
} = require('./optional-config');
const {
  diagnoseDisconnectRisk,
  applyPersistentClashKeepAlive,
  restorePersistentClashKeepAlive,
  applyRuntimeMihomoKeepAlive,
  buildHttpsOnlyCliArgs
} = require('./disconnect-diag');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_ROOT = path.join(PROJECT_ROOT, 'plugin-marketplace');
const PLUGIN_NAME = 'codex-no-tun';
const MARKETPLACE_NAME = 'codex-no-tun-local';

function parseArgs(argv) {
  const args = [...argv];
  const sepIdx = args.indexOf('--');
  let passthrough = [];
  let head = args;
  if (sepIdx !== -1) {
    head = args.slice(0, sepIdx);
    passthrough = args.slice(sepIdx + 1);
  }

  const cmd = head[0] && !head[0].startsWith('-') ? head[0] : 'help';
  const rest = cmd === 'help' && head[0] !== 'help' ? head : head.slice(1);
  const flags = { _: [] };

  // For 'cli' and 'launch' without '--', preserve unrecognized flags and positional args in order for forwarding.
  const forwardUnrecognized = (cmd === 'cli' || cmd === 'launch') && sepIdx === -1;

  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--proxy' || t === '-p') { flags.proxy = rest[++i]; }
    else if (t === '--bypass' || t === '--no-proxy') { flags.noProxy = rest[++i]; }
    else if (t === '--exe') { flags.exe = rest[++i]; }
    else if (t === '--out') { flags.out = rest[++i]; }
    else if (t === '--name') { flags.name = rest[++i]; }
    else if (t === '--probe') { flags.probe = rest[++i]; }
    else if (t === '--config' && !forwardUnrecognized) { flags.config = rest[++i]; }
    else if (t === '--section') { flags.section = rest[++i]; }
    else if (t === '--key') { flags.key = rest[++i]; }
    else if (t === '--value') { flags.value = rest[++i]; }
    else if (t === '--compact-limit') { flags.compactLimit = rest[++i]; }
    else if (t === '--compact') { flags.compact = rest[++i]; }
    else if (t === '--keepalive') { flags.keepalive = true; }
    else if (t === '--prevent-sleep') { flags.preventSleep = true; }
    else if (t === '--install-plugin') { flags.installPlugin = true; }
    else if (t === '--yes' || t === '-y') { flags.yes = true; }
    else if (t === '--runtime-only') { flags.runtimeOnly = true; }
    else if (t === '--desktop') { flags.desktop = true; }
    else if (t === '--no-shortcut') { flags.noShortcut = true; }
    else if (t === '--save') { flags.save = true; }
    else if (t === '--json') { flags.json = true; }
    else if (t === '--all') { flags.all = true; }
    else if (t === '--use-bundled-cli') { flags.useBundledCli = true; }
    else if (t === '--use-npm-cli') { flags.useNpmCli = true; }
    else if (t === '--https-only') { flags.httpsOnly = true; }
    else if (t === '--hours') { flags.hours = rest[++i]; }
    else if ((t === '--help' || t === '-h') && !forwardUnrecognized) { flags.help = true; }
    else if (forwardUnrecognized) { passthrough.push(t); }
    else { flags._.push(t); }
  }
  return { cmd, flags, passthrough };
}

function printHelp() {
  console.log(`Codex 免 TUN (Windows 工具包)

用法:
  node src/cli.js setup [--proxy <url>] [--compact balanced|aggressive|relaxed|<tokens>] [--keepalive] [--prevent-sleep] [--install-plugin] [--yes]
  node src/cli.js compact-limit [status|balanced|aggressive|relaxed|restore|<tokens>] [--json]
  node src/cli.js check [--proxy <url>] [--probe <url>] [--json]
  node src/cli.js status [--json]
  node src/cli.js detect [--json]
  node src/cli.js diagnose-10053 [--hours <24>] [--json]
  node src/cli.js fix-keepalive [--runtime-only] [--json]
  node src/cli.js restore-keepalive [--json]
  node src/cli.js stabilize-all [--compact-limit <120000>] [--json]
  node src/cli.js uninstall [--json]
  node src/cli.js preflight --proxy <url> [--probe <url>]
  node src/cli.js create-launcher [--proxy <url>] [--bypass <list>] [--exe <path>] [--out <dir>] [--name <name>] [--desktop] [--save] [--no-shortcut]
  node src/cli.js launch [--proxy <url>] [--bypass <list>] [--exe <path>] [-- <extra args>]
  node src/cli.js cli [--proxy <url>] [--bypass <list>] [--https-only] [--use-bundled-cli|--use-npm-cli] [-- <codex args...>]
  node src/cli.js clash-evidence [--all] [--json]
  node src/cli.js config preview|apply|restore [--section features|root] [--key respect_system_proxy] [--value false]
  node src/cli.js plugin status|install|uninstall|guide

说明:
  - 首版支持 Clash 本地 HTTP / Mixed 端口（例如 http://127.0.0.1:7897）。
  - 始终保留 localhost,127.0.0.1,::1 直连，不修改全局系统代理或 app.asar。
  - 代理不可用时立即中止并报错，绝不静默改为直连。
`);
}

function askLine(rl, promptText) {
  return new Promise((resolve) => rl.question(promptText, (ans) => resolve(ans)));
}

async function resolveProxyInteractiveOrFail(explicitProxy, options = {}) {
  if (explicitProxy) {
    const checked = parseAndValidateProxyUrl(explicitProxy);
    if (!checked.ok) throw new Error(checked.error);
    return { proxyUrl: checked.value, source: '命令行参数' };
  }

  const saved = detectProxyConfig({ projectRoot: PROJECT_ROOT, ...options });
  if (saved.detected && saved.enabled && saved.proxyUrl) {
    return { proxyUrl: saved.proxyUrl, source: `已保存配置 (${saved.configPath})`, noProxy: saved.noProxy };
  }

  const candidates = await discoverLocalProxyCandidates({ projectRoot: PROJECT_ROOT, ...options });
  if (!process.stdin.isTTY || options.nonInteractive) {
    if (candidates.length === 1 && candidates[0].reachable) {
      return { proxyUrl: candidates[0].url, source: candidates[0].sources.join(' / ') };
    }
    if (candidates.length === 0) {
      throw new Error('未探测到可用本地代理。请使用 --proxy http://127.0.0.1:<端口> 显式指定（请先启动 Clash / Mihomo）。');
    }
    const listStr = candidates.map((c, idx) => `  [${idx + 1}] ${c.redacted} (${c.reachable ? '可达' : '未监听'}) - ${c.sources.join(', ')}`).join('\n');
    throw new Error(`未指定 --proxy 且存在多个或未确认候选代理：\n${listStr}\n请使用 --proxy <url> 明确指定。`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n检测到以下本地代理候选：');
    candidates.forEach((c, idx) => {
      console.log(`  [${idx + 1}] ${c.redacted}  [${c.reachable ? '端口可达' : '未监听'}]  来源: ${c.sources.join(', ')}`);
    });
    console.log('  [0] 手动输入自定义代理地址 (例如 http://127.0.0.1:7897)');
    const defaultIdx = candidates.findIndex((c) => c.reachable);
    const promptHint = defaultIdx >= 0 ? `请选择序号 [默认 ${defaultIdx + 1}]: ` : '请选择序号 [0]: ';
    const answer = (await askLine(rl, promptHint)).trim();
    const chosenNum = answer === '' ? (defaultIdx >= 0 ? defaultIdx + 1 : 0) : Number(answer);

    if (Number.isInteger(chosenNum) && chosenNum >= 1 && chosenNum <= candidates.length) {
      const picked = candidates[chosenNum - 1];
      return { proxyUrl: picked.url, source: picked.sources.join(' / ') };
    }
    const manual = await askLine(rl, '请输入 HTTP / Mixed 代理地址 (例如 http://127.0.0.1:7897): ');
    const checked = parseAndValidateProxyUrl(manual);
    if (!checked.ok) throw new Error(checked.error);
    return { proxyUrl: checked.value, source: '手动输入' };
  } finally {
    rl.close();
  }
}

async function cmdCheck(flags) {
  const installs = detectCodexInstallations({ exePath: flags.exe });
  const envState = inspectEnvironmentState({ exePath: flags.exe });
  const candidates = await discoverLocalProxyCandidates({ explicitProxy: flags.proxy, projectRoot: PROJECT_ROOT });

  let activeProxy = flags.proxy || null;
  if (!activeProxy) {
    const saved = detectProxyConfig({ projectRoot: PROJECT_ROOT });
    if (saved.detected && saved.enabled) activeProxy = saved.proxyUrl;
    else if (candidates.find((c) => c.reachable)) activeProxy = candidates.find((c) => c.reachable).url;
    else if (candidates[0]) activeProxy = candidates[0].url;
  }

  const health = activeProxy
    ? await checkProxyHealth(activeProxy, { probeUrl: flags.probe || null, noProxy: flags.noProxy })
    : { configValid: false, proxyReachable: false, tunnelReachable: null, modelCallVerified: false, error: '未指定也未探测到代理地址' };

  const desktopRunning = envState.runningProcesses.filter((p) => p.isDesktopMain || p.isAppServer);
  const disconnectSummary = await diagnoseDisconnectRisk({ hours: 24 });
  const report = {
    installations: installs,
    environment: {
      tunUp: envState.tunUp,
      tunAdapters: envState.tunAdapters,
      winInetProxyEnable: envState.winInet.proxyEnable,
      winInetProxyServer: envState.winInet.proxyServer || null,
      clashConfigDir: envState.clash.dir,
      clashPorts: envState.clash.ports,
      codexConfig: envState.codexConfig,
      runningCodexCount: desktopRunning.length,
      warnings: envState.warnings
    },
    candidates,
    selectedProxyHealth: health,
    disconnectRisk: {
      count10053: disconnectSummary.logs.count10053,
      countWsClosed: disconnectSummary.logs.countWsClosed,
      countHttpFallback: disconnectSummary.logs.countHttpFallback,
      countSendRequestError: disconnectSummary.logs.countSendRequestError,
      countSendRequestRetries: disconnectSummary.logs.countSendRequestRetries,
      uploadTimeout120sLikely: disconnectSummary.logs.uploadTimeout120sLikely,
      maxRequestBytes: disconnectSummary.logs.maxRequestBytes,
      maxCompressedBytes: disconnectSummary.logs.maxCompressedBytes,
      oversizedContextRisk: disconnectSummary.logs.oversizedContextRisk,
      likelyImageHeavyPayload: disconnectSummary.logs.likelyImageHeavyPayload,
      estimatedUploadKBps: disconnectSummary.clash.estimatedUploadKBps,
      keepAliveIdle: disconnectSummary.clash.keepAliveIdle,
      keepAliveInterval: disconnectSummary.clash.keepAliveInterval,
      keepAliveUnset: disconnectSummary.clash.keepAliveUnset,
      nodeTimeoutCount: disconnectSummary.clash.nodeTimeoutCount
    }
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return health.configValid && health.proxyReachable ? 0 : 1;
  }

  console.log('=== Codex 免 TUN 诊断检查 ===');
  console.log(`Codex Desktop (MSIX): ${installs.desktop.msix ? `${installs.desktop.msix.version} (${installs.desktop.preferredTarget})` : '未检测到'}`);
  console.log(`Codex Desktop (独立版): ${installs.desktop.standalone || '未检测到'}`);
  console.log(`Codex CLI (npm): ${installs.cli.npmVersion || '未检测到'} (${installs.cli.npmCmd || '-'})`);
  console.log(`Codex CLI (MSIX 内置): ${installs.cli.bundledCliVersion || '未检测到'}`);
  console.log(`Node.js 运行时: ${installs.cli.nodeExe || '未检测到'}`);
  console.log(`Windows 系统代理: ${envState.winInet.proxyEnable ? `开启 (${envState.winInet.proxyServer})` : '关闭'}`);
  console.log(`TUN 虚拟网卡: ${envState.tunUp ? '开启 (Up)' : '未开启/未检测到'}`);
  console.log(`Codex Desktop 运行状态: ${desktopRunning.length > 0 ? `正在运行 (${desktopRunning.length} 个主/服务进程)` : '未运行'}`);
  console.log(`~/.codex/config.toml respect_system_proxy: ${envState.codexConfig.respectSystemProxy === null ? '未设置(默认 false，将尊重进程级代理变量)' : String(envState.codexConfig.respectSystemProxy)}`);

  console.log('\n--- 本地代理候选 ---');
  if (candidates.length === 0) {
    console.log('  (未发现候选端口)');
  } else {
    for (const c of candidates) {
      console.log(`  - ${c.redacted} [${c.reachable ? '端口可达' : '未监听'}] (${c.sources.join(', ')})`);
    }
  }

  console.log('\n--- 当前代理健康检查 ---');
  console.log(`  代理地址: ${health.proxyEndpoint || '无'}`);
  console.log(`  配置合法 (configValid): ${health.configValid}`);
  console.log(`  端口可达 (proxyReachable): ${health.proxyReachable}`);
  console.log(`  隧道探测 (tunnelReachable): ${health.tunnelReachable === null ? '未执行外网探测(离线检查通过)' : health.tunnelReachable}`);
  console.log(`  真实模型对话验证 (modelCallVerified): ${health.modelCallVerified} (需通过真实对话验收)`);
  if (health.error) console.log(`  提示/错误: ${health.error}`);

  if (envState.warnings.length > 0) {
    console.log('\n--- 注意事项 ---');
    envState.warnings.forEach((w) => console.log(`  ! ${w}`));
  }

  console.log('\n--- 抗断连健康检查 (os error 10053 / WebSocket / 120s 上传超时) ---');
  console.log(`  近24h 10053/WS断连/HTTP回退: ${disconnectSummary.logs.count10053} / ${disconnectSummary.logs.countWsClosed} / ${disconnectSummary.logs.countHttpFallback}`);
  console.log(`  近24h error sending request: ${disconnectSummary.logs.countSendRequestError} 次 (重试 ${disconnectSummary.logs.countSendRequestRetries} 次${disconnectSummary.logs.uploadTimeout120sLikely ? ', 疑似 120s 上传超时' : ''})`);
  const maxPreMb = disconnectSummary.logs.maxRequestBytes ? `${(disconnectSummary.logs.maxRequestBytes / (1024 * 1024)).toFixed(2)} MB` : '暂无记录';
  const maxPostMb = disconnectSummary.logs.maxCompressedBytes ? ` (zstd 后 ${(disconnectSummary.logs.maxCompressedBytes / (1024 * 1024)).toFixed(2)} MB${disconnectSummary.logs.likelyImageHeavyPayload ? ', 含大图/难压缩特征' : ''})` : '';
  console.log(`  最大单次请求体积: ${maxPreMb}${maxPostMb}`);
  console.log(`  Clash TCP 保活 (idle/interval): ${disconnectSummary.clash.keepAliveIdle ?? '未知'} / ${disconnectSummary.clash.keepAliveInterval ?? '未知'} 秒`);
  if (disconnectSummary.findings.length > 0) {
    console.log('  提示: 检测到断连/超时风险，可运行 `codex-notun-tool.cmd diagnose-10053` 查看根因与修复建议。');
  }

  return (health.configValid && health.proxyReachable) ? 0 : 1;
}

async function cmdPreflight(flags) {
  const checked = parseAndValidateProxyUrl(flags.proxy || '');
  if (!checked.ok) {
    console.error(checked.error);
    return 1;
  }
  const health = await checkProxyHealth(checked.value, { probeUrl: flags.probe || null, timeoutMs: 2000 });
  if (!health.configValid || !health.proxyReachable || health.tunnelReachable === false) {
    console.error(health.error || '代理不可用，已中止。');
    return 3;
  }
  return 0;
}

async function cmdCreateLauncher(flags) {
  const resolved = await resolveProxyInteractiveOrFail(flags.proxy);
  const health = await checkProxyHealth(resolved.proxyUrl, { timeoutMs: 2000 });
  if (!health.configValid || !health.proxyReachable) {
    throw new Error(health.error || '代理不可用，无法生成可用启动器');
  }

  const noProxy = ensureLoopbackNoProxy(flags.noProxy || resolved.noProxy || DEFAULT_NO_PROXY);
  if (flags.save) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const cfgTarget = flags.config || path.join(localAppData, 'CodexNoTun', 'config.json');
    saveProxyConfig(cfgTarget, { enabled: true, proxyUrl: resolved.proxyUrl, noProxy }, { projectRoot: PROJECT_ROOT });
    console.log(`已保存默认配置: ${cfgTarget}`);
  } else {
    try { recordToolkitRoot(PROJECT_ROOT); } catch {}
  }

  const outDir = flags.out ? path.resolve(flags.out) : path.join(PROJECT_ROOT, 'launcher');
  const shortcutDir = flags.out ? outDir : PROJECT_ROOT;
  const res = createStandaloneNoTunLauncher({
    proxyUrl: resolved.proxyUrl,
    noProxy,
    exePath: flags.exe,
    outDir,
    shortcutDir,
    shortcutName: flags.name || 'Codex 免 TUN',
    alsoDesktop: Boolean(flags.desktop),
    createShortcut: !flags.noShortcut
  });

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log('已生成免 TUN 启动器与快捷方式：');
    console.log(`  目标客户端: ${res.exePath}`);
    console.log(`  代理地址:   ${res.redactedProxyUrl}`);
    console.log(`  直连绕过:   ${res.noProxy}`);
    console.log(`  启动脚本:   ${res.launcherPath}`);
    if (res.shortcuts.length > 0) {
      res.shortcuts.forEach((s) => console.log(`  快捷方式:   ${s}`));
    }
  }
  return 0;
}

async function cmdLaunchDesktop(flags, passthrough) {
  const resolved = await resolveProxyInteractiveOrFail(flags.proxy);
  const health = await checkProxyHealth(resolved.proxyUrl, { timeoutMs: 2000 });
  if (!health.configValid || !health.proxyReachable) {
    console.error(`错误: ${health.error}`);
    return 3;
  }
  const envState = inspectEnvironmentState();
  const running = envState.runningProcesses.filter((p) => p.isDesktopMain || p.isAppServer);
  if (running.length > 0) {
    console.error('检测到 Codex 桌面版或后台服务正在运行。请先完全退出 Codex（包含系统托盘），再通过免 TUN 启动器启动，避免旧实例接管导致代理配置失效。');
    return 2;
  }

  const installs = detectCodexInstallations({ exePath: flags.exe });
  const targetExe = flags.exe || installs.desktop.preferredTarget;
  if (!targetExe) {
    console.error('未检测到 Codex Desktop 安装入口。');
    return 1;
  }

  const spec = buildDesktopLaunchSpec({
    proxyUrl: resolved.proxyUrl,
    noProxy: flags.noProxy || resolved.noProxy,
    extraArgs: passthrough
  });

  const child = spawn(targetExe, spec.args, {
    env: spec.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  console.log(`已通过进程级代理启动 Codex Desktop (${spec.redactedProxyUrl})。`);
  return 0;
}

function extractSemverTuple(verStr) {
  const m = String(verStr || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isVersionNewer(a, b) {
  const va = extractSemverTuple(a);
  const vb = extractSemverTuple(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] > vb[i];
  }
  return false;
}

async function cmdCliWrapper(flags, passthrough) {
  const resolved = await resolveProxyInteractiveOrFail(flags.proxy);
  const health = await checkProxyHealth(resolved.proxyUrl, { timeoutMs: 2000 });
  if (!health.configValid || !health.proxyReachable) {
    console.error(`错误: ${health.error}`);
    return 3;
  }

  const installs = detectCodexInstallations();
  const nodeExe = installs.cli.nodeExe;
  let bin;
  let prefixArgs = [];

  const hasNpm = Boolean((installs.cli.npmScript && nodeExe) || installs.cli.npmCmd);
  const hasBundled = Boolean(installs.cli.bundledCliExe);
  const preferBundled = flags.useBundledCli || (!flags.useNpmCli && hasBundled && (!hasNpm || isVersionNewer(installs.cli.bundledCliVersion, installs.cli.npmVersion)));

  if (preferBundled && hasBundled) {
    bin = installs.cli.bundledCliExe;
  } else if (installs.cli.npmScript && nodeExe) {
    bin = nodeExe;
    prefixArgs = [installs.cli.npmScript];
  } else if (installs.cli.npmCmd) {
    bin = installs.cli.npmCmd;
  } else if (hasBundled) {
    bin = installs.cli.bundledCliExe;
  } else {
    console.error('未检测到可用的 Codex CLI（未找到 npm @openai/codex 或 MSIX 内置 codex.exe）。');
    return 1;
  }

  const env = buildCliProxyEnv(process.env, {
    proxyUrl: resolved.proxyUrl,
    noProxy: flags.noProxy || resolved.noProxy,
    nodeExe
  });

  const httpsOnlyArgs = flags.httpsOnly ? buildHttpsOnlyCliArgs() : [];
  if (flags.httpsOnly) {
    console.error('[Codex 免 TUN] 已启用进程级 --https-only（强制 HTTPS + zstd，关闭 WebSocket，不改 config.toml）。');
  }

  return await new Promise((resolve) => {
    const child = spawn(bin, [...prefixArgs, ...httpsOnlyArgs, ...passthrough], {
      env,
      stdio: 'inherit',
      shell: bin.toLowerCase().endsWith('.cmd')
    });
    child.on('error', (err) => {
      console.error(`启动 Codex CLI 失败: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

function resolveCodexCliBinForPlugin() {
  const installs = detectCodexInstallations();
  if (installs.cli.bundledCliExe) return { bin: installs.cli.bundledCliExe, prefix: [] };
  if (installs.cli.npmScript && installs.cli.nodeExe) return { bin: installs.cli.nodeExe, prefix: [installs.cli.npmScript] };
  return null;
}

function cmdPlugin(flags) {
  const sub = flags._[0] || 'guide';
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configToml = path.join(codexHome, 'config.toml');

  if (sub === 'guide') {
    console.log('=== Codex 插件安装与卸载指引 ===');
    console.log(`本地插件市场路径: ${MARKETPLACE_ROOT}`);
    console.log('1) 添加本地插件市场:');
    console.log(`   codex plugin marketplace add "${MARKETPLACE_ROOT}"`);
    console.log('2) 安装并启用插件:');
    console.log(`   codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    console.log('3) 卸载与移除:');
    console.log(`   codex plugin remove ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    console.log(`   codex plugin marketplace remove ${MARKETPLACE_NAME}`);
    console.log('\n或者直接运行: codex-notun-tool.cmd plugin install');
    return 0;
  }

  if (sub === 'status') {
    const manifestPath = path.join(MARKETPLACE_ROOT, 'plugins', PLUGIN_NAME, '.codex-plugin', 'plugin.json');
    const mpPath = path.join(MARKETPLACE_ROOT, '.agents', 'plugins', 'marketplace.json');
    const installedInConfig = fs.existsSync(configToml) && fs.readFileSync(configToml, 'utf8').includes(PLUGIN_NAME);
    console.log(JSON.stringify({
      marketplaceRoot: MARKETPLACE_ROOT,
      marketplaceManifestExists: fs.existsSync(mpPath),
      pluginManifestExists: fs.existsSync(manifestPath),
      codexHome,
      referencedInUserConfigToml: installedInConfig
    }, null, 2));
    return 0;
  }

  const cli = resolveCodexCliBinForPlugin();
  if (!cli) {
    console.error('未找到 Codex CLI，无法自动执行插件管理命令。');
    return 1;
  }

  if (sub === 'install') {
    try { recordToolkitRoot(PROJECT_ROOT); } catch {}
    execFileSync(cli.bin, [...cli.prefix, 'plugin', 'marketplace', 'add', MARKETPLACE_ROOT], { stdio: 'inherit' });
    execFileSync(cli.bin, [...cli.prefix, 'plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { stdio: 'inherit' });
    console.log(`插件 ${PLUGIN_NAME}@${MARKETPLACE_NAME} 已安装。如在 Codex Desktop 中未立即显示，请重启客户端。`);
    return 0;
  }

  if (sub === 'uninstall') {
    try {
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { stdio: 'inherit' });
    } catch {}
    try {
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME], { stdio: 'inherit' });
    } catch {}
    console.log(`插件 ${PLUGIN_NAME}@${MARKETPLACE_NAME} 已移除。`);
    return 0;
  }

  console.error(`未知插件子命令: ${sub}`);
  return 1;
}

function parseTomlInputValue(rawVal) {
  if (rawVal === 'true') return true;
  if (rawVal === 'false') return false;
  if (/^-?\d+$/.test(String(rawVal))) return Number(rawVal);
  return rawVal;
}

function cmdConfig(flags) {
  const sub = flags._[0] || 'preview';
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const tomlPath = flags.config || path.join(codexHome, 'config.toml');
  const rawSection = flags.section !== undefined ? flags.section : 'features';
  const section = rawSection === 'root' ? '' : rawSection;
  const key = flags.key || 'respect_system_proxy';
  const rawVal = flags.value !== undefined ? flags.value : 'false';
  const parsedVal = parseTomlInputValue(rawVal);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const safeSlug = `${rawSection || 'root'}-${key}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const defaultState = path.join(localAppData, 'CodexNoTun', `config-toml-${safeSlug}.json`);
  const legacyState = path.join(localAppData, 'CodexNoTun', 'config-toml-state.json');
  const stateFile = (sub === 'restore' && !fs.existsSync(defaultState) && fs.existsSync(legacyState))
    ? legacyState
    : defaultState;

  if (sub === 'preview') {
    const p = previewTomlKeyChange(tomlPath, section, key, parsedVal);
    console.log('=== 可选 Codex config.toml 单键修改预览（未写入磁盘）===');
    console.log(`目标文件: ${p.filePath}`);
    console.log(`变更动作: ${p.action}`);
    console.log(`原有行:   ${p.previousLine === null ? '(不存在)' : p.previousLine}`);
    console.log(`目标行:   ${section ? `[${section}]` : '(根级)'} -> ${p.newLine}`);
    console.log('提示: 若确认写入，请显式执行: node src/cli.js config apply');
    return 0;
  }
  if (sub === 'apply') {
    const res = applyTomlKeyChange(tomlPath, section, key, parsedVal, { stateFile });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  if (sub === 'restore') {
    const res = restoreTomlKeyChange(tomlPath, { stateFile });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  console.error(`未知 config 子命令: ${sub}`);
  return 1;
}

async function cmdDiagnose10053(flags) {
  const res = await diagnoseDisconnectRisk({ hours: flags.hours || 24 });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log('=== Codex os error 10053 / 120s 上传超时专项诊断 ===');
  console.log(`统计窗口: 最近 ${res.logs.hours} 小时`);
  console.log(`logs_2.sqlite: ${res.logs.available ? '只读读取成功' : `不可用 (${res.logs.error})`}`);
  console.log(`  os error 10053 次数: ${res.logs.count10053}`);
  console.log(`  WebSocket 断开次数:  ${res.logs.countWsClosed}`);
  console.log(`  触发 HTTP 回退次数:  ${res.logs.countHttpFallback}`);
  console.log(`  平均断连间隔:        ${res.logs.avgDisconnectIntervalSec ? `${res.logs.avgDisconnectIntervalSec} 秒` : '不足以计算'}`);
  console.log(`  error sending req:   ${res.logs.countSendRequestError} 次 (采样重试 ${res.logs.countSendRequestRetries} 次)`);
  console.log(`  平均失败/超时间隔:   ${res.logs.avgSendRequestIntervalSec ? `${res.logs.avgSendRequestIntervalSec} 秒${res.logs.uploadTimeout120sLikely ? ' (符合 120s 上传超时特征)' : ''}` : '不足以计算'}`);
  console.log(`  最大请求体 (压缩前): ${res.logs.maxRequestBytes ? `${(res.logs.maxRequestBytes / (1024 * 1024)).toFixed(2)} MB` : '暂无'}`);
  console.log(`  最大请求体 (压缩后): ${res.logs.maxCompressedBytes ? `${(res.logs.maxCompressedBytes / (1024 * 1024)).toFixed(2)} MB` : '暂无'}`);
  if (res.logs.largestPayloadCompressRatio !== null) {
    console.log(`  压缩后占比/含图风险: ${Math.round(res.logs.largestPayloadCompressRatio * 100)}% (${res.logs.likelyImageHeavyPayload ? '高：疑似含 base64 图片/不可压缩大附件' : '正常文本比例'})`);
  }
  if (res.logs.latestTokens !== null || res.logs.latestAutoCompactLimit !== null) {
    console.log(`  最新 Token / 阈值:   ${res.logs.latestTokens ?? '未知'} / ${res.logs.latestAutoCompactLimit ?? '官方默认'}`);
  }

  console.log('\n--- Clash Mihomo 稳定性 ---');
  console.log(`  控制管道连通:        ${res.clash.pipeReachable}`);
  console.log(`  keep-alive-idle:     ${res.clash.keepAliveIdle}`);
  console.log(`  keep-alive-interval: ${res.clash.keepAliveInterval}`);
  console.log(`  disable-keep-alive:  ${res.clash.disableKeepAlive}`);
  console.log(`  当前节点:            ${res.clash.activeNodeName || '未知'} (${res.clash.activeNodeType || '-'})`);
  console.log(`  活跃 Codex 连接数:   ${res.clash.activeCodexConnections ?? 0}`);
  console.log(`  估算节点上传速度:    ${res.clash.estimatedUploadKBps !== null ? `${res.clash.estimatedUploadKBps} KB/s${res.clash.slowUploadWarning ? ' (偏慢告警)' : ''}` : '暂无大包上传样本'}`);
  console.log(`  近期日志超时告警:    ${res.clash.nodeTimeoutCount} 条`);

  console.log('\n--- 诊断发现 ---');
  if (res.findings.length === 0) {
    console.log('  未发现明显 10053 断连风险。');
  } else {
    res.findings.forEach((f, idx) => console.log(`  ${idx + 1}. ${f}`));
  }

  console.log('\n--- 修复与防断连建议 ---');
  res.recommendations.forEach((r, idx) => console.log(`  ${idx + 1}. ${r}`));
  return 0;
}

async function cmdFixKeepAlive(flags) {
  if (flags.runtimeOnly) {
    const res = await applyRuntimeMihomoKeepAlive({ idle: 15, interval: 15 });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
      return res.ok ? 0 : 1;
    }
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  const res = await applyPersistentClashKeepAlive({ idle: 15, interval: 15 });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  console.log('=== Clash Verge 15s TCP Keep-Alive 配置结果 ===');
  res.files.forEach((f) => console.log(`  已更新: ${f.path} (备份: ${f.backupPath || '新建'})`));
  console.log(`  热重载 Mihomo: ${res.reloaded ? '成功' : `未完成 (${res.reloadError})`}`);
  console.log(`  回读验证: keep-alive-idle=${res.current.keepAliveIdle}, keep-alive-interval=${res.current.keepAliveInterval}, disable-keep-alive=${res.current.disableKeepAlive}, tun=${res.current.tunEnabled}`);
  return (res.ok && res.verified) ? 0 : 1;
}

async function cmdRestoreKeepAlive(flags) {
  const res = await restorePersistentClashKeepAlive();
  console.log(JSON.stringify(res, null, 2));
  return res.ok ? 0 : 1;
}

async function cmdStabilizeAll(flags) {
  const compactLimit = Number.isFinite(Number(flags.compactLimit)) && Number(flags.compactLimit) > 0
    ? Number(flags.compactLimit)
    : 120000;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const tomlPath = flags.config || path.join(codexHome, 'config.toml');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  const clashRes = await applyPersistentClashKeepAlive({ idle: 15, interval: 15 });
  const compactRes = applyTomlKeyChange(tomlPath, '', 'model_auto_compact_token_limit', compactLimit, {
    stateFile: path.join(localAppData, 'CodexNoTun', 'config-toml-root-model_auto_compact_token_limit.json')
  });
  const sleepRes = applyTomlKeyChange(tomlPath, 'features', 'prevent_idle_sleep', true, {
    stateFile: path.join(localAppData, 'CodexNoTun', 'config-toml-features-prevent_idle_sleep.json')
  });

  const out = {
    ok: clashRes.verified && compactRes.ok && sleepRes.ok,
    clashKeepAlive: clashRes,
    codexAutoCompact: compactRes,
    codexPreventIdleSleep: sleepRes
  };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('=== Codex 一键抗断连与自动压缩优化完成 ===');
    console.log(`1. Clash 15s TCP Keep-Alive: verified=${clashRes.verified} (idle=${clashRes.current.keepAliveIdle}, interval=${clashRes.current.keepAliveInterval}, tun=${clashRes.current.tunEnabled})`);
    console.log(`2. Codex 自动压缩阈值:       ${compactRes.appliedLine} (备份: ${compactRes.backupPath})`);
    console.log(`3. Codex 防休眠开关:         [features] ${sleepRes.appliedLine} (备份: ${sleepRes.backupPath})`);
  }
  return out.ok ? 0 : 1;
}

async function cmdCompactLimit(flags) {
  const arg = flags._[0];
  if (!arg || arg === 'status') {
    if (!arg && process.stdin.isTTY && !flags.json) {
      const status = getCompactLimitStatus({ configPath: flags.config });
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n=== 调整 Codex 自动压缩上下文上限 (model_auto_compact_token_limit) ===');
        console.log(`当前配置: ${status.configured ? `${status.tokens} (${status.label})` : status.label}`);
        console.log('\n可选档位：');
        console.log(`  [1] 激进抗断连: ${COMPACT_PRESETS.aggressive.tokens} (${COMPACT_PRESETS.aggressive.ratioHint}) - ${COMPACT_PRESETS.aggressive.description}`);
        console.log(`  [2] 平衡推荐:   ${COMPACT_PRESETS.balanced.tokens} (${COMPACT_PRESETS.balanced.ratioHint}) - ${COMPACT_PRESETS.balanced.description}`);
        console.log(`  [3] 较宽松:     ${COMPACT_PRESETS.relaxed.tokens} (${COMPACT_PRESETS.relaxed.ratioHint}) - ${COMPACT_PRESETS.relaxed.description}`);
        console.log('  [4] 自定义整数 (20000 ~ 450000)');
        console.log('  [5] 恢复官方默认 (移除此配置键)');
        console.log('  [0] 保持不变并退出');
        const ans = (await askLine(rl, '请选择序号 [0-5]: ')).trim();
        if (!ans || ans === '0') {
          console.log('未做修改。');
          return 0;
        }
        let targetInput = null;
        if (ans === '1') targetInput = 'aggressive';
        else if (ans === '2') targetInput = 'balanced';
        else if (ans === '3') targetInput = 'relaxed';
        else if (ans === '5') targetInput = 'restore';
        else if (ans === '4') targetInput = (await askLine(rl, '请输入自定义 token 上限 (例如 150000): ')).trim();
        else throw new Error(`无效选项: ${ans}`);

        const applied = applyCompactLimitPreset(targetInput, { configPath: flags.config });
        console.log(applied.action === 'restore'
          ? '已还原 model_auto_compact_token_limit，将使用 Codex 官方默认阈值。'
          : `已设置为 ${applied.tokens} tokens (${applied.label})，备份位于: ${applied.backupPath || '新建文件'}`);
        return 0;
      } finally {
        rl.close();
      }
    }
    const status = getCompactLimitStatus({ configPath: flags.config });
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`当前自动压缩阈值: ${status.configured ? `${status.tokens} (${status.label})` : status.label}`);
      console.log('可选档位: aggressive (120000) / balanced (180000) / relaxed (250000) / restore');
    }
    return 0;
  }

  const res = applyCompactLimitPreset(arg, { configPath: flags.config });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.action === 'restore') {
    console.log(`已还原 model_auto_compact_token_limit (${res.outcome})。`);
  } else {
    console.log(`已将自动压缩阈值设置为 ${res.tokens} tokens (${res.label})，备份: ${res.backupPath || '新建文件'}`);
  }
  return 0;
}

async function cmdSetup(flags) {
  try { recordToolkitRoot(PROJECT_ROOT); } catch {}
  console.log('=== Codex 免 TUN 一键安装与配置向导 ===');

  const resolved = await resolveProxyInteractiveOrFail(flags.proxy);
  const health = await checkProxyHealth(resolved.proxyUrl, { timeoutMs: 2000 });
  if (!health.configValid || !health.proxyReachable) {
    throw new Error(health.error || '代理不可用，已中止配置（不会静默直连）');
  }

  const noProxy = ensureLoopbackNoProxy(flags.noProxy || resolved.noProxy || DEFAULT_NO_PROXY);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cfgTarget = flags.config || path.join(localAppData, 'CodexNoTun', 'config.json');
  saveProxyConfig(cfgTarget, { enabled: true, proxyUrl: resolved.proxyUrl, noProxy }, { projectRoot: PROJECT_ROOT });

  const launcherRes = createStandaloneNoTunLauncher({
    proxyUrl: resolved.proxyUrl,
    noProxy,
    exePath: flags.exe,
    outDir: path.join(PROJECT_ROOT, 'launcher'),
    shortcutDir: PROJECT_ROOT,
    shortcutName: flags.name || 'Codex 免 TUN',
    alsoDesktop: true,
    createShortcut: true
  });
  console.log(`\n[1/4] 代理与桌面快捷方式已就绪: ${launcherRes.shortcuts.join(' , ')}`);

  let compactChoice = flags.compact || null;
  let applyKeepAlive = Boolean(flags.keepalive);
  let applyPreventSleep = Boolean(flags.preventSleep);
  let installPlugin = Boolean(flags.installPlugin);

  if (flags.yes) {
    if (!compactChoice) compactChoice = 'balanced';
    applyKeepAlive = true;
    applyPreventSleep = true;
    installPlugin = true;
  } else if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!compactChoice) {
        console.log('\n[2/4] 选择自动压缩上下文阈值（防止长对话大包引发 10053 断连）：');
        console.log(`  [1] 平衡推荐 (${COMPACT_PRESETS.balanced.tokens}) - ${COMPACT_PRESETS.balanced.description}`);
        console.log(`  [2] 激进抗断连 (${COMPACT_PRESETS.aggressive.tokens}) - ${COMPACT_PRESETS.aggressive.description}`);
        console.log(`  [3] 较宽松 (${COMPACT_PRESETS.relaxed.tokens}) - ${COMPACT_PRESETS.relaxed.description}`);
        console.log('  [4] 自定义数值');
        console.log('  [0] 暂不修改 (保留官方默认)');
        const cAns = (await askLine(rl, '请选择 [默认 1]: ')).trim();
        if (cAns === '' || cAns === '1') compactChoice = 'balanced';
        else if (cAns === '2') compactChoice = 'aggressive';
        else if (cAns === '3') compactChoice = 'relaxed';
        else if (cAns === '4') compactChoice = (await askLine(rl, '请输入自定义 token 上限 (20000~450000): ')).trim();
      }
      if (!applyKeepAlive && !applyPreventSleep) {
        const kAns = (await askLine(rl, '\n[3/4] 是否写入 Clash Verge 15s TCP 保活并开启 Codex 防休眠？(Y/n): ')).trim().toLowerCase();
        if (kAns === '' || kAns === 'y' || kAns === 'yes') {
          applyKeepAlive = true;
          applyPreventSleep = true;
        }
      }
      if (!installPlugin) {
        const pAns = (await askLine(rl, '\n[4/4] 是否安装 Codex 插件「Codex 免 TUN」（可在界面 @Codex 免 TUN 诊断）？(Y/n): ')).trim().toLowerCase();
        if (pAns === '' || pAns === 'y' || pAns === 'yes') {
          installPlugin = true;
        }
      }
    } finally {
      rl.close();
    }
  }

  if (compactChoice) {
    const cRes = applyCompactLimitPreset(compactChoice);
    console.log(`  已设置自动压缩上限: ${cRes.tokens} tokens (${cRes.label})`);
  }
  if (applyKeepAlive) {
    const kRes = await applyPersistentClashKeepAlive({ idle: 15, interval: 15 });
    console.log(`  Clash 15s TCP 保活: verified=${kRes.verified} (idle=${kRes.current.keepAliveIdle}, interval=${kRes.current.keepAliveInterval})`);
  }
  if (applyPreventSleep) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    applyTomlKeyChange(path.join(codexHome, 'config.toml'), 'features', 'prevent_idle_sleep', true, {
      stateFile: path.join(localAppData, 'CodexNoTun', 'config-toml-features-prevent_idle_sleep.json')
    });
    console.log('  Codex 防休眠开关: 已开启 prevent_idle_sleep = true');
  }
  if (installPlugin) {
    const cli = resolveCodexCliBinForPlugin();
    if (cli) {
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'marketplace', 'add', MARKETPLACE_ROOT], { stdio: 'inherit' });
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { stdio: 'inherit' });
      console.log('  Codex 插件已安装。');
    } else {
      console.log('  未检测到 Codex CLI，跳过自动安装插件（后续可运行 codex-notun-tool.cmd plugin install）。');
    }
  }

  console.log('\n配置全部完成！');
  console.log('请保持 Clash 运行并关闭 TUN 模式，完全退出当前 Codex 窗口后，双击桌面「Codex 免 TUN.lnk」启动。');
  return 0;
}

async function cmdUninstall(flags) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const tomlPath = path.join(codexHome, 'config.toml');
  const results = {
    compactRestored: null,
    preventSleepRestored: null,
    respectProxyRestored: null,
    clashKeepAliveRestored: null,
    pluginRemoved: false,
    removedShortcuts: []
  };

  try {
    const r = restoreCompactLimit();
    if (r.ok) results.compactRestored = r.outcome;
  } catch {}

  for (const [field, fileSlug] of [
    ['preventSleepRestored', 'config-toml-features-prevent_idle_sleep.json'],
    ['respectProxyRestored', 'config-toml-features-respect_system_proxy.json']
  ]) {
    const sf = path.join(localAppData, 'CodexNoTun', fileSlug);
    if (fs.existsSync(sf)) {
      try {
        const r = restoreTomlKeyChange(tomlPath, { stateFile: sf });
        if (r.ok) results[field] = r.outcome;
      } catch {}
    }
  }

  try {
    const kr = await restorePersistentClashKeepAlive();
    if (kr.ok) results.clashKeepAliveRestored = kr.restoredFiles;
  } catch {}

  const cli = resolveCodexCliBinForPlugin();
  if (cli) {
    try {
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { stdio: 'ignore' });
      results.pluginRemoved = true;
    } catch {}
    try {
      execFileSync(cli.bin, [...cli.prefix, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME], { stdio: 'ignore' });
    } catch {}
  }

  const desktopDir = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop');
  for (const lnk of [
    path.join(desktopDir, 'Codex 免 TUN.lnk'),
    path.join(PROJECT_ROOT, 'Codex 免 TUN.lnk')
  ]) {
    if (fs.existsSync(lnk)) {
      try { fs.unlinkSync(lnk); results.removedShortcuts.push(lnk); } catch {}
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('=== Codex 免 TUN 还原与卸载完成 ===');
    console.log(JSON.stringify(results, null, 2));
    console.log(`如需彻底清理残留缓存，可删除目录: ${path.join(localAppData, 'CodexNoTun')}`);
  }
  return 0;
}

async function main() {
  const { cmd, flags, passthrough } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help') {
    printHelp();
    return 0;
  }
  if (cmd === 'setup') return await cmdSetup(flags);
  if (cmd === 'compact-limit') return await cmdCompactLimit(flags);
  if (cmd === 'uninstall') return await cmdUninstall(flags);
  if (cmd === 'check' || cmd === 'status') return await cmdCheck(flags);
  if (cmd === 'diagnose-10053') return await cmdDiagnose10053(flags);
  if (cmd === 'fix-keepalive') return await cmdFixKeepAlive(flags);
  if (cmd === 'restore-keepalive') return await cmdRestoreKeepAlive(flags);
  if (cmd === 'stabilize-all') return await cmdStabilizeAll(flags);
  if (cmd === 'detect') {
    const candidates = await discoverLocalProxyCandidates({ explicitProxy: flags.proxy, projectRoot: PROJECT_ROOT });
    console.log(JSON.stringify(candidates, null, 2));
    return 0;
  }
  if (cmd === 'preflight') return await cmdPreflight(flags);
  if (cmd === 'create-launcher') return await cmdCreateLauncher(flags);
  if (cmd === 'launch') return await cmdLaunchDesktop(flags, passthrough);
  if (cmd === 'cli') return await cmdCliWrapper(flags, passthrough);
  if (cmd === 'clash-evidence') {
    const res = await queryClashConnectionsSanitized({ all: Boolean(flags.all) });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  if (cmd === 'plugin') return cmdPlugin(flags);
  if (cmd === 'config') return cmdConfig(flags);

  console.error(`未知命令: ${cmd}`);
  printHelp();
  return 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(Number.isInteger(code) ? code : 0))
    .catch((err) => {
      console.error(`错误: ${err?.message || err}`);
      process.exit(1);
    });
}

module.exports = { parseArgs, main };
