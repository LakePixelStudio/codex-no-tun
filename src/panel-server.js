'use strict';
/**
 * Zero-dependency loopback HTTP server & sleek standalone side-panel launcher
 * for Codex No-TUN (does NOT inject into app.asar or touch Windows global proxy).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { checkProxyHealth, redactProxyUrl, sanitizeDiagnosticErrorText } = require('./proxy-core');
const {
  detectProxyConfig,
  discoverLocalProxyCandidates,
  detectCodexInstallations,
  inspectEnvironmentState,
  queryClashConnectionsSanitized,
  recordToolkitRoot
} = require('./discovery');
const { getCompactLimitStatus, applyCompactLimitPreset } = require('./compact-presets');
const {
  diagnoseDisconnectRisk,
  applyPersistentClashKeepAlive,
  restorePersistentClashKeepAlive
} = require('./disconnect-diag');
const { buildDesktopLaunchSpec } = require('./launcher');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

function getPanelVersion(projectRoot = DEFAULT_PROJECT_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch {}
  return '0.6.0';
}

function getPanelStatePath(options = {}) {
  if (options.stateFile) return path.resolve(options.stateFile);
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return path.join(localAppData, 'CodexNoTun', 'panel-state.json');
}

function findBrowserAppExe(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';

  const candidates = [
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];

  for (const p of candidates) {
    try {
      if (fsImpl.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function openPanelWindow(url, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const env = options.env || process.env;
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const browserExe = options.browserExe !== undefined ? options.browserExe : findBrowserAppExe(options);

  if (browserExe) {
    const profileDir = path.join(localAppData, 'CodexNoTun', 'panel-profile');
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
    const child = spawnImpl(browserExe, [
      `--app=${url}`,
      '--window-size=440,860',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { mode: 'app-window', browserExe, url };
  }

  const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { mode: 'default-browser', browserExe: null, url };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('无效的 JSON 请求体')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function queryRunningPanelHealth(port, timeoutMs = 1000) {
  return await new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(json && json.ok ? json : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function resolveSelectedProxy(projectRoot, envState) {
  const saved = detectProxyConfig({ projectRoot });
  if (saved.detected && saved.enabled && saved.proxyUrl) {
    return { proxyUrl: saved.proxyUrl, noProxy: saved.noProxy || null, source: 'config.json' };
  }
  const candidates = await discoverLocalProxyCandidates({ projectRoot, envState });
  const picked = candidates.find((c) => c.reachable) || candidates[0];
  if (picked) {
    return { proxyUrl: picked.url, noProxy: null, source: picked.sources.join(' / ') };
  }
  return null;
}

async function startPanelServer(options = {}) {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : DEFAULT_PROJECT_ROOT;
  const version = options.version || getPanelVersion(projectRoot);
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const htmlPath = options.htmlPath || path.join(__dirname, 'panel-ui.html');
  const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');
  const renderedHtml = htmlTemplate
    .replace(/\{\{PANEL_TOKEN\}\}/g, token)
    .replace(/\{\{APP_VERSION\}\}/g, version);

  const stateFile = options.disableLockFile ? null : getPanelStatePath(options);
  const startedAtMs = Date.now();
  let seenClient = false;
  let lastPingMs = startedAtMs;
  let actualPort = 0;
  let closed = false;
  let heartbeatTimer = null;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${actualPort || 80}`);
    const pathname = reqUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(renderedHtml);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, version });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/ping') {
      seenClient = true;
      lastPingMs = Date.now();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/overview') {
      try {
        const installs = options._mockInstallations || detectCodexInstallations();
        const envState = options._mockEnvState || inspectEnvironmentState();
        const selected = options._mockSelectedProxy !== undefined
          ? options._mockSelectedProxy
          : await resolveSelectedProxy(projectRoot, envState);
        const health = selected
          ? (options._mockHealth || await checkProxyHealth(selected.proxyUrl, { timeoutMs: 1500, noProxy: selected.noProxy }))
          : { configValid: false, proxyReachable: false, error: '未探测到可用本地代理' };
        const desktopRunningProcs = envState.runningProcesses.filter((p) => p.isDesktopMain || p.isAppServer);
        const compactLimit = getCompactLimitStatus({ configPath: options.configPath });
        const disconnect = await diagnoseDisconnectRisk({
          hours: 24,
          dbPath: options.dbPath,
          clashLogFile: options.clashLogFile,
          _mockConfigsRes: options._mockConfigsRes,
          _mockProxiesRes: options._mockProxiesRes,
          _mockConnectionsRes: options._mockConnectionsRes
        });

        sendJson(res, 200, {
          ok: true,
          version,
          timestamp: new Date().toISOString(),
          codex: {
            desktopVersion: installs.desktop.msix?.version || (installs.desktop.standalone ? 'standalone' : null),
            cliVersion: installs.cli.bundledCliVersion || installs.cli.npmVersion || null,
            desktopRunning: desktopRunningProcs.length > 0,
            runningProcessCount: desktopRunningProcs.length,
            respectSystemProxy: envState.codexConfig.respectSystemProxy
          },
          proxy: {
            configuredUrl: selected ? redactProxyUrl(selected.proxyUrl) : null,
            source: selected ? selected.source : null,
            health
          },
          environment: {
            tunUp: envState.tunUp,
            winInetProxyEnable: envState.winInet.proxyEnable,
            winInetProxyServer: envState.winInet.proxyServer || null
          },
          compactLimit,
          disconnect
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: sanitizeDiagnosticErrorText(err) });
      }
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      const expectedOrigin = `http://127.0.0.1:${actualPort}`;
      if (origin && origin !== expectedOrigin) {
        sendJson(res, 403, { ok: false, error: '禁止跨域访问控制面板 API' });
        return;
      }
      const reqToken = req.headers['x-codex-panel-token'];
      if (!reqToken || reqToken !== token) {
        sendJson(res, 403, { ok: false, error: '缺少或无效的控制面板校验令牌 (X-Codex-Panel-Token)' });
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      try {
        if (pathname === '/api/compact-limit') {
          if (body.value === undefined || body.value === null || String(body.value).trim() === '') {
            sendJson(res, 400, { ok: false, error: '缺少档位或 token 数值参数 value' });
            return;
          }
          const result = applyCompactLimitPreset(String(body.value), { configPath: options.configPath });
          sendJson(res, 200, { ok: true, result });
          return;
        }

        if (pathname === '/api/diagnose') {
          const hours = Number.isFinite(Number(body.hours)) && Number(body.hours) > 0 ? Number(body.hours) : 24;
          const diag = await diagnoseDisconnectRisk({
            hours,
            dbPath: options.dbPath,
            clashLogFile: options.clashLogFile,
            _mockConfigsRes: options._mockConfigsRes,
            _mockProxiesRes: options._mockProxiesRes,
            _mockConnectionsRes: options._mockConnectionsRes
          });
          sendJson(res, 200, diag);
          return;
        }

        if (pathname === '/api/fix-keepalive') {
          const resFix = await applyPersistentClashKeepAlive({ idle: 15, interval: 15 });
          sendJson(res, 200, resFix);
          return;
        }

        if (pathname === '/api/restore-keepalive') {
          const resRestore = await restorePersistentClashKeepAlive();
          sendJson(res, 200, resRestore);
          return;
        }

        if (pathname === '/api/clash-evidence') {
          const connRes = await queryClashConnectionsSanitized({ all: Boolean(body.all) });
          sendJson(res, 200, connRes);
          return;
        }

        if (pathname === '/api/plugin-install') {
          const installs = detectCodexInstallations();
          let bin = null;
          let prefix = [];
          if (installs.cli.bundledCliExe) {
            bin = installs.cli.bundledCliExe;
          } else if (installs.cli.npmScript && installs.cli.nodeExe) {
            bin = installs.cli.nodeExe;
            prefix = [installs.cli.npmScript];
          }
          if (!bin) {
            sendJson(res, 400, { ok: false, error: '未检测到 Codex CLI，无法自动安装/刷新插件。' });
            return;
          }
          try { recordToolkitRoot(projectRoot); } catch {}
          const mpRoot = path.join(projectRoot, 'plugin-marketplace');
          execFileSync(bin, [...prefix, 'plugin', 'marketplace', 'add', mpRoot], { stdio: 'pipe', windowsHide: true });
          execFileSync(bin, [...prefix, 'plugin', 'add', 'codex-no-tun@codex-no-tun-local'], { stdio: 'pipe', windowsHide: true });
          sendJson(res, 200, { ok: true, message: `插件已更新安装到 v${version}，重启 Codex Desktop 后生效。` });
          return;
        }

        if (pathname === '/api/launch-desktop') {
          const envState = inspectEnvironmentState();
          const running = envState.runningProcesses.filter((p) => p.isDesktopMain || p.isAppServer);
          if (running.length > 0) {
            sendJson(res, 409, {
              ok: false,
              error: '检测到 Codex 桌面版正在运行。请先完全退出 Codex（含系统托盘图标），再点击启动，避免旧实例接管导致代理失效。'
            });
            return;
          }
          const selected = await resolveSelectedProxy(projectRoot, envState);
          if (!selected) {
            sendJson(res, 400, { ok: false, error: '未探测到可用本地代理，请先运行 Clash Verge / Mihomo。' });
            return;
          }
          const health = await checkProxyHealth(selected.proxyUrl, { timeoutMs: 2000, noProxy: selected.noProxy });
          if (!health.configValid || !health.proxyReachable) {
            sendJson(res, 503, { ok: false, error: health.error || '本地代理不可达，已中止启动（绝不静默直连）。' });
            return;
          }
          const installs = detectCodexInstallations();
          const targetExe = installs.desktop.preferredTarget;
          if (!targetExe) {
            sendJson(res, 404, { ok: false, error: '未检测到 Codex Desktop 安装路径。' });
            return;
          }
          const spec = buildDesktopLaunchSpec({ proxyUrl: selected.proxyUrl, noProxy: selected.noProxy });
          const child = spawn(targetExe, spec.args, {
            env: spec.env,
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          });
          child.unref();
          sendJson(res, 200, { ok: true, proxy: spec.redactedProxyUrl });
          return;
        }

        if (pathname === '/api/shutdown') {
          sendJson(res, 200, { ok: true });
          setTimeout(() => { stop(); }, 150).unref();
          return;
        }

        sendJson(res, 404, { ok: false, error: '未知接口路径' });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: sanitizeDiagnosticErrorText(err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  });

  function cleanupStateFile() {
    if (!stateFile) return;
    try {
      if (fs.existsSync(stateFile)) {
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (cur && cur.pid === process.pid) {
          fs.unlinkSync(stateFile);
        }
      }
    } catch {}
  }

  function stop() {
    if (closed) return Promise.resolve();
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    cleanupStateFile();
    return new Promise((resolve) => {
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {}
      server.close(() => resolve());
    });
  }

  await new Promise((resolve, reject) => {
    const port = Number.isInteger(Number(options.port)) ? Number(options.port) : 0;
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      actualPort = server.address().port;
      resolve();
    });
  });

  if (stateFile) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        pid: process.pid,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        startedAt: new Date(startedAtMs).toISOString()
      }, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch {}
  }

  if (options.autoExit) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (seenClient && (now - lastPingMs > 25000)) {
        stop();
      } else if (!seenClient && (now - startedAtMs > 60000)) {
        stop();
      }
    }, 5000);
    heartbeatTimer.unref();
  }

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    token,
    version,
    stop,
    waitForClose: () => new Promise((resolve) => server.once('close', resolve))
  };
}

module.exports = {
  getPanelStatePath,
  findBrowserAppExe,
  openPanelWindow,
  queryRunningPanelHealth,
  startPanelServer
};
