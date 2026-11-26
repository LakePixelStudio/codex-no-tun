'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { startPanelServer, findBrowserAppExe } = require('../src/panel-server');
const { generateWindowsPanelVbs, createPanelLauncher } = require('../src/launcher');
const { getCompactLimitStatus } = require('../src/compact-presets');

function httpRequestJson(urlStr, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const reqHeaders = Object.assign({}, headers);
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = payload.length;
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('panel-server: HTML 注入、CSRF 令牌与 Origin 校验、三档压缩切换/还原与诊断接口', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-srv-'));
  let srv = null;
  try {
    const configPath = path.join(tempRoot, 'config.toml');
    fs.writeFileSync(configPath, 'model = "gpt-6.2-sol"\n', 'utf8');

    srv = await startPanelServer({
      port: 0,
      disableLockFile: true,
      configPath,
      dbPath: path.join(tempRoot, 'missing-logs.sqlite'),
      clashLogFile: path.join(tempRoot, 'missing-clash.log'),
      _mockInstallations: {
        desktop: { msix: { version: '26.1120.6357.0' }, standalone: null },
        cli: { bundledCliVersion: '0.171.0', npmVersion: null }
      },
      _mockEnvState: {
        tunUp: false,
        winInet: { proxyEnable: false, proxyServer: null },
        runningProcesses: [],
        codexConfig: { respectSystemProxy: false }
      },
      _mockSelectedProxy: { proxyUrl: 'http://127.0.0.1:7897', noProxy: null, source: 'mock' },
      _mockHealth: { configValid: true, proxyReachable: true, error: null },
      _mockConfigsRes: {
        ok: true,
        json: { 'keep-alive-idle': 15, 'keep-alive-interval': 15, 'disable-keep-alive': false, tun: { enable: false } }
      },
      _mockProxiesRes: { ok: false },
      _mockConnectionsRes: { ok: false }
    });

    const htmlRes = await httpRequestJson(`${srv.url}/`, 'GET');
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.text, /Codex 免 TUN 控制台/);
    assert.equal(htmlRes.text.includes(srv.token), true);

    const healthRes = await httpRequestJson(`${srv.url}/api/health`, 'GET');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.ok, true);

    const overviewRes = await httpRequestJson(`${srv.url}/api/overview`, 'GET');
    assert.equal(overviewRes.status, 200);
    assert.equal(overviewRes.json.ok, true);
    assert.equal(overviewRes.json.compactLimit.configured, false);
    assert.equal(overviewRes.json.proxy.health.proxyReachable, true);

    // 缺少 Token 必须被 403 拒绝
    const noTokenRes = await httpRequestJson(
      `${srv.url}/api/compact-limit`,
      'POST',
      {},
      { value: 'balanced' }
    );
    assert.equal(noTokenRes.status, 403);

    // 跨站 Origin 必须被 403 拒绝
    const badOriginRes = await httpRequestJson(
      `${srv.url}/api/compact-limit`,
      'POST',
      {
        'Origin': 'https://evil.example',
        'X-Codex-Panel-Token': srv.token
      },
      { value: 'balanced' }
    );
    assert.equal(badOriginRes.status, 403);

    // 携带合法 Token 可切换三档并无损恢复默认
    const setRes = await httpRequestJson(
      `${srv.url}/api/compact-limit`,
      'POST',
      {
        'Origin': srv.url,
        'X-Codex-Panel-Token': srv.token
      },
      { value: 'balanced' }
    );
    assert.equal(setRes.status, 200);
    assert.equal(setRes.json.ok, true);
    assert.equal(setRes.json.result.tokens, 180000);
    assert.equal(getCompactLimitStatus({ configPath }).tokens, 180000);

    const restoreRes = await httpRequestJson(
      `${srv.url}/api/compact-limit`,
      'POST',
      {
        'X-Codex-Panel-Token': srv.token
      },
      { value: 'restore' }
    );
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.json.result.action, 'restore');
    assert.equal(getCompactLimitStatus({ configPath }).configured, false);

    const diagRes = await httpRequestJson(
      `${srv.url}/api/diagnose`,
      'POST',
      { 'X-Codex-Panel-Token': srv.token },
      { hours: 24 }
    );
    assert.equal(diagRes.status, 200);
    assert.equal(Array.isArray(diagRes.json.findings), true);
    assert.equal(Array.isArray(diagRes.json.recommendations), true);

    const shutRes = await httpRequestJson(
      `${srv.url}/api/shutdown`,
      'POST',
      { 'X-Codex-Panel-Token': srv.token },
      {}
    );
    assert.equal(shutRes.status, 200);
    await srv.waitForClose();
    srv = null;
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('createPanelLauncher: 含中文和空格路径生成纯 ASCII 面板 VBS 与快捷方式', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-lnk-'));
  try {
    const dir = path.join(tempRoot, '测试 目录');
    const outDir = path.join(dir, 'launcher');
    const fakeNode = path.join(dir, 'node.exe');
    const fakeCli = path.join(dir, 'src', 'cli.js');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(fakeNode, 'stub', 'utf8');
    fs.writeFileSync(fakeCli, '// stub', 'utf8');

    const vbs = generateWindowsPanelVbs({ nodeExe: fakeNode, cliJsPath: fakeCli });
    assert.equal(/[^\x00-\x7F]/.test(vbs), false, '面板 VBS 必须保持纯 ASCII');
    assert.match(vbs, /panel --auto-exit/);

    const res = createPanelLauncher({
      projectRoot: dir,
      installations: { desktop: { msix: null, standalone: null } },
      nodeExe: fakeNode,
      cliJsPath: fakeCli,
      outDir,
      shortcutDir: dir,
      desktopDir: false
    });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(res.launcherPath), true);
    assert.equal(fs.existsSync(res.shortcutPath), true);
    // findBrowserAppExe should never throw
    assert.doesNotThrow(() => findBrowserAppExe());
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
