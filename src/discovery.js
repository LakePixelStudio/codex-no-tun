'use strict';
/**
 * Read-only discovery of local proxy configs, Clash Verge/Mihomo ports (no secrets),
 * WinINet proxy state, TUN adapter state, Codex Desktop/CLI installations,
 * running Codex processes, and sanitized Mihomo connection evidence.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const {
  DEFAULT_NO_PROXY,
  normalizeProxyUrl,
  parseAndValidateProxyUrl,
  ensureLoopbackNoProxy,
  checkTcpPort
} = require('./proxy-core');

function getConfigCandidatePaths(customPath = null, options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [];
  if (env.CODEX_NOTUN_CONFIG) {
    list.push(path.resolve(env.CODEX_NOTUN_CONFIG));
  }
  if (customPath && typeof customPath === 'string' && customPath.trim()) {
    list.push(path.resolve(customPath.trim()));
  }
  list.push(path.join(localAppData, 'CodexNoTun', 'config.json'));
  if (options.projectRoot) {
    list.push(path.join(path.resolve(options.projectRoot), 'config.json'));
  }
  return [...new Set(list)];
}

/**
 * Fail-closed config loader adapted from meter-proxy.js detectProxyConfig.
 */
function detectProxyConfig(options = {}) {
  const candidates = options.candidates || getConfigCandidatePaths(options.configPath, options);
  const fsImpl = options.fs || fs;

  for (const cfgPath of candidates) {
    try {
      if (!fsImpl.existsSync(cfgPath)) continue;
      const content = fsImpl.readFileSync(cfgPath, 'utf8');
      if (!content || !content.trim()) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'empty_file' };
      }
      const cfg = JSON.parse(content);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_schema' };
      }
      if (cfg.enabled === false) {
        return { detected: true, enabled: false, configPath: cfgPath };
      }
      const rawUrl = normalizeProxyUrl(cfg.proxyUrl || cfg.httpProxy || '');
      if (!rawUrl) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'missing_proxy_url' };
      }
      const checked = parseAndValidateProxyUrl(rawUrl, options);
      if (!checked.ok) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: checked.error };
      }
      const noProxy = ensureLoopbackNoProxy(cfg.noProxy !== undefined ? cfg.noProxy : DEFAULT_NO_PROXY);
      return {
        detected: true,
        enabled: true,
        configPath: cfgPath,
        proxyUrl: checked.value,
        noProxy
      };
    } catch (err) {
      return { detected: true, enabled: false, configPath: cfgPath, parseError: err?.message || 'parse_error' };
    }
  }
  return { detected: false, enabled: false, configPath: null };
}

function recordToolkitRoot(rootDir, options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const markerPath = path.join(localAppData, 'CodexNoTun', 'toolkit-root.txt');
  fsImpl.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmp, path.resolve(rootDir) + '\n', 'utf8');
  fsImpl.renameSync(tmp, markerPath);
  return markerPath;
}

function saveProxyConfig(configPath, data, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(configPath);
  fsImpl.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = {
    schemaVersion: 1,
    enabled: data.enabled !== false,
    proxyUrl: normalizeProxyUrl(data.proxyUrl),
    noProxy: ensureLoopbackNoProxy(data.noProxy),
    updatedAt: new Date().toISOString()
  };
  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fsImpl.renameSync(tmpPath, resolved);
  if (options.projectRoot) {
    try { recordToolkitRoot(options.projectRoot, options); } catch {}
  }
  return { ok: true, configPath: resolved, config: payload };
}

function runPowerShellSync(script, extraEnv = {}, timeoutMs = 6000, run = execFileSync) {
  return String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore']
  })).trim();
}

/**
 * Read-only extract of Clash Verge / Mihomo local ports and TUN flag.
 * Strictly ignores any lines mentioning secret, password, token, key, auth, or node definitions.
 */
function readClashVergePortsReadOnly(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const fsImpl = options.fs || fs;
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const dirCandidates = options.clashDirs || [
    path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(appData, 'clash-verge'),
    path.join(home, '.config', 'clash-verge'),
    path.join(home, '.config', 'mihomo')
  ];

  const found = {
    dir: null,
    ports: [],
    tunEnabledInConfig: null,
    systemProxyEnabledInConfig: null,
    controllerPipe: null
  };

  for (const d of dirCandidates) {
    if (!fsImpl.existsSync(d)) continue;
    found.dir = d;
    for (const fileName of ['verge.yaml', 'clash-verge.yaml', 'config.yaml']) {
      const fp = path.join(d, fileName);
      if (!fsImpl.existsSync(fp)) continue;
      let content = '';
      try {
        content = fsImpl.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      let inTunSection = false;
      let skipNestedSection = false;
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '');
        if (!line.trim()) continue;
        if (/secret|password|token|auth|uuid|cipher|psk/i.test(line)) continue;
        if (/^[a-zA-Z0-9_-]+\s*:/.test(line) && !/^\s/.test(line)) {
          const topKey = line.split(':')[0].trim().toLowerCase();
          inTunSection = topKey === 'tun';
          skipNestedSection = ['proxies', 'proxy-groups', 'rules', 'rule-providers', 'proxy-providers'].includes(topKey);
        }
        if (skipNestedSection) continue;
        if (inTunSection && /^\s+enable\s*:\s*(true|false)/i.test(line)) {
          found.tunEnabledInConfig = RegExp.$1.toLowerCase() === 'true';
        }
        const mMixed = line.match(/^(verge_mixed_port|mixed-port|port)\s*:\s*(\d{2,5})\s*$/);
        if (mMixed) {
          const portNum = Number(mMixed[2]);
          if (portNum >= 1 && portNum <= 65535) {
            found.ports.push({ key: mMixed[1], port: portNum, file: fileName });
          }
        }
        const mTun = line.match(/^enable_tun_mode\s*:\s*(true|false)\s*$/i);
        if (mTun) found.tunEnabledInConfig = mTun[1].toLowerCase() === 'true';
        const mSys = line.match(/^enable_system_proxy\s*:\s*(true|false)\s*$/i);
        if (mSys) found.systemProxyEnabledInConfig = mSys[1].toLowerCase() === 'true';
        const mPipe = line.match(/^external-controller-pipe\s*:\s*(.+?)\s*$/);
        if (mPipe) found.controllerPipe = mPipe[1].replace(/^['"]|['"]$/g, '').trim();
      }
    }
    if (found.ports.length > 0 || found.tunEnabledInConfig !== null) break;
  }

  return found;
}

function readWinInetProxySettings(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { proxyEnable: false, proxyServer: null, proxyOverride: null, autoConfigUrl: null };
  }
  try {
    const out = runPowerShellSync(
      "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; " +
      "[pscustomobject]@{ proxyEnable = [bool]($p.ProxyEnable -eq 1); proxyServer = $p.ProxyServer; proxyOverride = $p.ProxyOverride; autoConfigUrl = $p.AutoConfigURL } | ConvertTo-Json -Compress",
      {},
      4000,
      options._execFileSync
    );
    return out ? JSON.parse(out) : { proxyEnable: false, proxyServer: null };
  } catch {
    return { proxyEnable: false, proxyServer: null, error: '无法读取 WinINet 注册表设置' };
  }
}

function parseWinInetProxyServerToUrl(proxyServer) {
  const raw = String(proxyServer || '').trim();
  if (!raw) return null;
  if (raw.includes('=')) {
    const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
    const httpsPart = parts.find((p) => /^https=/i.test(p)) || parts.find((p) => /^http=/i.test(p));
    if (!httpsPart) return null;
    const val = httpsPart.split('=').slice(1).join('=').trim();
    return val.includes('://') ? val : `http://${val}`;
  }
  return raw.includes('://') ? raw : `http://${raw}`;
}

/**
 * Discover local HTTP/Mixed proxy candidates (read-only) and check TCP reachability.
 */
async function discoverLocalProxyCandidates(options = {}) {
  const env = options.env || process.env;
  const rawList = [];

  if (options.explicitProxy) {
    rawList.push({ url: options.explicitProxy, source: '命令行参数', priority: 1 });
  }
  const saved = detectProxyConfig(options);
  if (saved.detected && saved.enabled && saved.proxyUrl) {
    rawList.push({ url: saved.proxyUrl, source: `已保存配置 (${path.basename(saved.configPath)})`, priority: 2 });
  }

  const clash = readClashVergePortsReadOnly(options);
  for (const item of clash.ports) {
    rawList.push({
      url: `http://127.0.0.1:${item.port}`,
      source: `Clash 配置 (${item.file}: ${item.key})`,
      priority: item.key.includes('mixed') ? 3 : 4
    });
  }

  const winInet = readWinInetProxySettings(options);
  const winInetUrl = parseWinInetProxyServerToUrl(winInet.proxyServer);
  if (winInetUrl) {
    rawList.push({
      url: winInetUrl,
      source: `Windows 系统代理 (${winInet.proxyEnable ? '当前开启' : '历史记录/当前关闭'})`,
      priority: winInet.proxyEnable ? 5 : 6
    });
  }

  for (const envKey of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (env[envKey]) {
      rawList.push({ url: env[envKey], source: `进程环境变量 (${envKey})`, priority: 7 });
    }
  }

  for (const port of [7897, 7890, 17890, 10809]) {
    rawList.push({
      url: `http://127.0.0.1:${port}`,
      source: `常见本地代理端口探测 (${port})`,
      priority: 9,
      onlyIfReachable: true
    });
  }

  const byUrl = new Map();
  for (const item of rawList) {
    const parsed = parseAndValidateProxyUrl(item.url);
    if (!parsed.ok) continue;
    const key = parsed.value;
    if (!byUrl.has(key)) {
      byUrl.set(key, {
        url: parsed.value,
        redacted: parsed.redacted,
        hostname: parsed.hostname,
        port: parsed.port,
        sources: [item.source],
        priority: item.priority,
        onlyIfReachable: Boolean(item.onlyIfReachable)
      });
    } else {
      const existing = byUrl.get(key);
      if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
      existing.onlyIfReachable = existing.onlyIfReachable && Boolean(item.onlyIfReachable);
    }
  }

  const results = [];
  for (const cand of byUrl.values()) {
    const tcp = options.skipReachabilityCheck
      ? { ok: null, durationMs: 0 }
      : await checkTcpPort(cand.hostname, cand.port, 800);
    if (cand.onlyIfReachable && !tcp.ok) continue;
    results.push({
      url: cand.url,
      redacted: cand.redacted,
      hostname: cand.hostname,
      port: cand.port,
      sources: cand.sources,
      reachable: tcp.ok,
      durationMs: tcp.durationMs
    });
  }

  results.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    return 0;
  });
  return results;
}

function resolveNodeExecutable(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const candidates = [];
  if (options.nodePath) candidates.push(options.nodePath);
  if (typeof process.execPath === 'string' && /node(\.exe)?$/i.test(process.execPath)) {
    candidates.push(process.execPath);
  }
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  candidates.push(
    path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
    path.join(programFiles, 'nodejs', 'node.exe')
  );
  for (const p of candidates) {
    if (p && fsImpl.existsSync(p)) return p;
  }
  return null;
}

function fileExistsOrReparse(fsImpl, targetPath) {
  if (fsImpl.existsSync(targetPath)) return true;
  if (typeof fsImpl.lstatSync === 'function') {
    try {
      fsImpl.lstatSync(targetPath);
      return true;
    } catch {}
  }
  return false;
}

function detectCodexInstallations(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const result = {
    desktop: {
      msix: null,
      standalone: null,
      preferredTarget: null,
      preferredKind: null
    },
    cli: {
      npmCmd: null,
      npmScript: null,
      npmVersion: null,
      bundledCliExe: null,
      bundledCliVersion: null,
      nodeExe: resolveNodeExecutable(options)
    }
  };

  if (platform !== 'win32') {
    return result;
  }

  try {
    const appxJson = runPowerShellSync(
      "$p = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1 Name, PackageFullName, Version, InstallLocation, PackageFamilyName; if ($p) { $p | ConvertTo-Json -Compress }",
      {},
      6000,
      options._execFileSync
    );
    if (appxJson) {
      const appx = JSON.parse(appxJson);
      const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const aliasPath = path.join(localAppData, 'Microsoft', 'WindowsApps', 'chatgpt-desktop.exe');
      const scopedAlias = path.join(localAppData, 'Microsoft', 'WindowsApps', appx.PackageFamilyName || '', 'chatgpt-desktop.exe');
      const exeInPackage = path.join(appx.InstallLocation, 'app', 'ChatGPT.exe');
      const bundledCodex = path.join(appx.InstallLocation, 'app', 'resources', 'codex.exe');

      let bundledVer = null;
      if (fsImpl.existsSync(bundledCodex)) {
        try {
          bundledVer = String((options._execFileSync || execFileSync)(bundledCodex, ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 4000,
            stdio: ['ignore', 'pipe', 'ignore']
          })).trim();
        } catch {}
      }

      const aliasResolved = fileExistsOrReparse(fsImpl, aliasPath)
        ? aliasPath
        : (fileExistsOrReparse(fsImpl, scopedAlias) ? scopedAlias : null);
      result.desktop.msix = {
        name: appx.Name,
        version: appx.Version,
        packageFullName: appx.PackageFullName,
        packageFamilyName: appx.PackageFamilyName,
        installLocation: appx.InstallLocation,
        appExecutionAlias: aliasResolved,
        packageExe: fsImpl.existsSync(exeInPackage) ? exeInPackage : null,
        bundledCodexExe: fsImpl.existsSync(bundledCodex) ? bundledCodex : null,
        bundledCodexVersion: bundledVer
      };
      result.cli.bundledCliExe = result.desktop.msix.bundledCodexExe;
      result.cli.bundledCliVersion = bundledVer;
      result.desktop.preferredTarget = aliasResolved || result.desktop.msix.packageExe;
      result.desktop.preferredKind = aliasResolved ? 'msix-alias' : 'msix-exe';
    }
  } catch {}

  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const standaloneCandidates = [
    options.exePath,
    path.join(localAppData, 'Programs', 'Codex', 'Codex.exe'),
    path.join(localAppData, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
    path.join(programFiles, 'Codex', 'Codex.exe'),
    path.join(programFiles, 'OpenAI', 'Codex', 'Codex.exe')
  ].filter(Boolean);

  for (const cand of standaloneCandidates) {
    if (fsImpl.existsSync(cand)) {
      result.desktop.standalone = cand;
      if (!result.desktop.preferredTarget || options.exePath) {
        result.desktop.preferredTarget = cand;
        result.desktop.preferredKind = 'standalone-exe';
      }
      break;
    }
  }

  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const npmCmd = path.join(appData, 'npm', 'codex.cmd');
  const npmScript = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fsImpl.existsSync(npmCmd)) result.cli.npmCmd = npmCmd;
  if (fsImpl.existsSync(npmScript)) {
    result.cli.npmScript = npmScript;
    if (result.cli.nodeExe) {
      try {
        result.cli.npmVersion = String((options._execFileSync || execFileSync)(result.cli.nodeExe, [npmScript, '--version'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore']
        })).trim();
      } catch {}
    }
  }

  return result;
}

function detectRunningCodexProcesses(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [];
  try {
    const out = runPowerShellSync(
      "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe' OR Name = 'Codex.exe' OR Name = 'codex.exe'\" | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine; " +
      "if ($procs) { $procs | ConvertTo-Json -Compress }",
      {},
      6000,
      options._execFileSync
    );
    if (!out) return [];
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => {
      const cmd = String(p.CommandLine || '');
      const isElectronMain = /^(ChatGPT|Codex)\.exe$/i.test(String(p.Name || '')) && !/\s--type=/.test(cmd);
      const isAppServer = /^codex\.exe$/i.test(String(p.Name || '')) && /\bapp-server\b/.test(cmd);
      return {
        pid: p.ProcessId,
        parentPid: p.ParentProcessId,
        name: p.Name,
        executablePath: p.ExecutablePath || '',
        isDesktopMain: isElectronMain,
        isAppServer
      };
    });
  } catch {
    return [];
  }
}

function inspectCodexUserConfigReadOnly(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const tomlPath = path.join(codexHome, 'config.toml');
  const envPath = path.join(codexHome, '.env');

  const summary = {
    codexHome,
    configTomlExists: fsImpl.existsSync(tomlPath),
    respectSystemProxy: null,
    systemProxyFallback: null,
    shellEnvironmentInherit: null,
    windowsSandbox: null,
    dotenvExists: fsImpl.existsSync(envPath),
    dotenvProxyKeyNames: []
  };

  if (summary.configTomlExists) {
    try {
      const content = fsImpl.readFileSync(tomlPath, 'utf8');
      let section = '';
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const secM = line.match(/^\[([^\]]+)\]$/);
        if (secM) {
          section = secM[1].trim();
          continue;
        }
        const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!kv) continue;
        const [, k, v] = kv;
        if (section === 'features' && k === 'respect_system_proxy') {
          summary.respectSystemProxy = v === 'true';
        } else if (section === 'features' && k === 'system_proxy_fallback') {
          summary.systemProxyFallback = v === 'true';
        } else if (section === 'shell_environment_policy' && k === 'inherit') {
          summary.shellEnvironmentInherit = v.replace(/^["']|["']$/g, '');
        } else if (section === 'windows' && k === 'sandbox') {
          summary.windowsSandbox = v.replace(/^["']|["']$/g, '');
        }
      }
    } catch {}
  }

  if (summary.dotenvExists) {
    try {
      const content = fsImpl.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
        if (m && /proxy/i.test(m[1])) {
          summary.dotenvProxyKeyNames.push(m[1]);
        }
      }
    } catch {}
  }

  return summary;
}

function detectTunAdapterState(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [];
  try {
    const out = runPowerShellSync(
      "$a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Mihomo|Clash|Wintun|TUN' -or $_.Name -match 'Mihomo|Clash|TUN' } | Select-Object Name, InterfaceDescription, Status; if ($a) { $a | ConvertTo-Json -Compress }",
      {},
      4000,
      options._execFileSync
    );
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function inspectEnvironmentState(options = {}) {
  const winInet = readWinInetProxySettings(options);
  const clash = readClashVergePortsReadOnly(options);
  const codexConfig = inspectCodexUserConfigReadOnly(options);
  const tunAdapters = detectTunAdapterState(options);
  const runningProcesses = detectRunningCodexProcesses(options);
  const tunUp = tunAdapters.some((a) => String(a.Status || '').toLowerCase() === 'up');

  const warnings = [];
  if (codexConfig.respectSystemProxy === true && !winInet.proxyEnable) {
    warnings.push(
      '检测到 ~/.codex/config.toml 中 respect_system_proxy=true 且 Windows 系统代理处于关闭状态：' +
      'Codex 将走直连并忽略环境变量中的 HTTP_PROXY/HTTPS_PROXY。建议保持 respect_system_proxy 为默认关闭(false)，或使用本启动器。'
    );
  }
  if (codexConfig.dotenvProxyKeyNames.length > 0) {
    warnings.push(
      `检测到 ~/.codex/.env 存在代理变量名 (${codexConfig.dotenvProxyKeyNames.join(', ')})；` +
      '进程启动器注入的环境变量优先级高于 .env，但若直接启动 Codex 则会读取该 .env。'
    );
  }
  if (tunUp) {
    warnings.push('检测到 Mihomo / Wintun TUN 虚拟网卡当前处于开启(Up)状态；进行免 TUN 验收时请在 Clash Verge 中关闭 TUN 模式。');
  }

  return {
    winInet,
    clash,
    codexConfig,
    tunAdapters,
    tunUp,
    runningProcesses,
    warnings
  };
}

function queryClashConnectionsSanitized(options = {}) {
  const pipePath = options.pipePath || '\\\\.\\pipe\\verge-mihomo';
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: pipePath,
      path: '/connections',
      method: 'GET',
      timeout: Number(options.timeoutMs) || 3000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, status: res.statusCode, connections: [], error: `Mihomo 管道返回 HTTP ${res.statusCode}` });
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const all = Array.isArray(parsed.connections) ? parsed.connections : [];
          const filtered = all
            .map((c) => {
              const md = c.metadata || {};
              const host = String(md.host || md.sniffHost || md.destinationIP || '');
              const proc = path.basename(String(md.processPath || md.process || ''));
              return {
                host,
                port: String(md.destinationPort || ''),
                network: String(md.network || ''),
                type: String(md.type || ''),
                rule: String(c.rule || ''),
                chains: Array.isArray(c.chains) ? c.chains.map((ch) => String(ch)) : [],
                process: proc,
                start: String(c.start || '')
              };
            })
            .filter((item) => {
              if (options.all) return true;
              return /openai|chatgpt|codex|oaiusercontent|auth0/i.test(item.host) || /codex|chatgpt/i.test(item.process);
            });
          resolve({ ok: true, totalConnections: all.length, connections: filtered });
        } catch (err) {
          resolve({ ok: false, connections: [], error: err?.message || '解析失败' });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, connections: [], error: `无法访问 Clash Mihomo 管道 (${err.message})` });
    });
    req.end();
  });
}

module.exports = {
  getConfigCandidatePaths,
  detectProxyConfig,
  recordToolkitRoot,
  saveProxyConfig,
  readClashVergePortsReadOnly,
  readWinInetProxySettings,
  parseWinInetProxyServerToUrl,
  discoverLocalProxyCandidates,
  resolveNodeExecutable,
  detectCodexInstallations,
  detectRunningCodexProcesses,
  inspectCodexUserConfigReadOnly,
  detectTunAdapterState,
  inspectEnvironmentState,
  queryClashConnectionsSanitized
};
