'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { requestViaProxy } = require('../src/proxy-core');
const { detectCodexInstallations } = require('../src/discovery');
const { buildCliProxyEnv } = require('../src/launcher');

test('mock-proxy-e2e: 外部请求严格走本地模拟代理、回环直连绕过、失效代理报错不直连', async () => {
  const proxyEvents = [];

  const localCallbackSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('local-callback-ok');
  });
  await new Promise((r) => localCallbackSrv.listen(0, '127.0.0.1', r));
  const localPort = localCallbackSrv.address().port;

  const mockProxy = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  mockProxy.on('connect', (req, clientSocket) => {
    proxyEvents.push({ type: 'connect', url: req.url });
    const [h, p] = String(req.url).split(':');
    if (h === 'mock-remote.test' && Number(p) === localPort) {
      const upstream = net.connect(localPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      return;
    }
    clientSocket.write('HTTP/1.1 502 Mock Blocked\r\nConnection: close\r\n\r\n');
    clientSocket.end();
  });
  await new Promise((r) => mockProxy.listen(0, '127.0.0.1', r));
  const proxyPort = mockProxy.address().port;

  const deadSrv = net.createServer();
  await new Promise((r) => deadSrv.listen(0, '127.0.0.1', r));
  const deadPort = deadSrv.address().port;
  await new Promise((r) => deadSrv.close(r));

  try {
    // 1. 经由 mock HTTP CONNECT 隧道访问外部虚拟域名（实际转发给本地桩以保持离线可测）
    const viaProxy = await requestViaProxy(`http://mock-remote.test:${localPort}/test`, {
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      noProxy: 'localhost,127.0.0.1,::1'
    });
    assert.equal(viaProxy.ok, true);
    assert.equal(viaProxy.text, 'local-callback-ok');
    assert.equal(viaProxy.route, 'http_connect_proxy');
    assert.equal(proxyEvents.some((e) => e.url === `mock-remote.test:${localPort}`), true);

    // 2. 本机回环 (127.0.0.1 / localhost) 直连，不经过代理
    const countBefore = proxyEvents.length;
    const loop1 = await requestViaProxy(`http://127.0.0.1:${localPort}/cb`, {
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      noProxy: 'localhost,127.0.0.1,::1'
    });
    const loop2 = await requestViaProxy(`http://localhost:${localPort}/cb`, {
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      noProxy: 'localhost,127.0.0.1,::1'
    });
    assert.equal(loop1.route, 'loopback_direct');
    assert.equal(loop2.route, 'loopback_direct');
    assert.equal(proxyEvents.length, countBefore, '回环地址不得触发代理');

    // 3. 代理端口失效时必须报错，绝不静默回落直连
    await assert.rejects(
      requestViaProxy(`http://mock-remote.test:${localPort}/test`, {
        proxyUrl: `http://127.0.0.1:${deadPort}`,
        timeoutMs: 1000
      }),
      /HTTP 代理连接失败/
    );
  } finally {
    await Promise.all([
      new Promise((r) => localCallbackSrv.close(r)),
      new Promise((r) => mockProxy.close(r))
    ]);
  }
});

test('mock-proxy-e2e: 真实 codex CLI 子进程通过构建环境将请求发往本地模拟 HTTP 代理，且失效代理立即中文报错退出', async () => {
  const installs = detectCodexInstallations();
  const codexBin = installs.cli.bundledCliExe;
  if (!codexBin) {
    return;
  }

  const connectTargets = [];
  const mockProxy = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  mockProxy.on('connect', (req, sock) => {
    sock.on('error', () => {});
    connectTargets.push(req.url);
    sock.write('HTTP/1.1 502 Mock Stop\r\nConnection: close\r\n\r\n');
    sock.end();
  });
  await new Promise((r) => mockProxy.listen(0, '127.0.0.1', r));
  const proxyPort = mockProxy.address().port;

  const projectRoot = path.resolve(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, '.tmp-e2e-'));
  const workDir = path.join(tempRoot, 'work');
  const homeDir = path.join(tempRoot, 'codex-home');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.toml'), 'model = "gpt-5.1-codex"\n', 'utf8');

  try {
    const env = buildCliProxyEnv({
      ...process.env,
      CODEX_HOME: homeDir,
      OPENAI_API_KEY: 'sk-test-mock-key'
    }, { proxyUrl: `http://127.0.0.1:${proxyPort}` });

    await new Promise((resolve) => {
      const child = spawn(codexBin, ['exec', '--skip-git-repo-check', 'hi'], {
        cwd: workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 9000);
      const checkDone = () => {
        if (connectTargets.some((t) => /openai|chatgpt/i.test(t))) {
          clearTimeout(timer);
          try { child.kill(); } catch {}
          resolve();
        }
      };
      mockProxy.on('connect', checkDone);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    assert.equal(
      connectTargets.some((t) => /openai\.com:443|chatgpt\.com:443/i.test(t)),
      true,
      `预期 codex.exe 通过代理 CONNECT 到 OpenAI/ChatGPT，实际收到: ${JSON.stringify(connectTargets)}`
    );

    // 验证失效代理下 CLI 包装命令立即中文报错退出
    const deadSrv = net.createServer();
    await new Promise((r) => deadSrv.listen(0, '127.0.0.1', r));
    const deadPort = deadSrv.address().port;
    await new Promise((r) => deadSrv.close(r));

    const cliRes = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'cli.js'), 'cli', '--proxy', `http://127.0.0.1:${deadPort}`, '--', '--version'], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(cliRes.code, 3);
    assert.match(cliRes.stderr, /代理端口不可达/);
  } finally {
    await new Promise((r) => mockProxy.close(r));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
