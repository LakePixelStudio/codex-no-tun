'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const {
  DEFAULT_NO_PROXY,
  parseAndValidateProxyUrl,
  redactProxyUrl,
  sanitizeDiagnosticErrorText,
  isLoopbackHost,
  matchesNoProxy,
  ensureLoopbackNoProxy,
  toChromiumBypassList,
  checkProxyHealth
} = require('../src/proxy-core');

test('parseAndValidateProxyUrl: 校验合法地址、拒绝非法/空/越界/未支持协议', () => {
  assert.equal(parseAndValidateProxyUrl('').ok, false);
  assert.equal(parseAndValidateProxyUrl('   ').ok, false);
  assert.equal(parseAndValidateProxyUrl('ftp://127.0.0.1:21').ok, false);
  assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:0').ok, false);
  assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:65536').ok, false);
  assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:abc').ok, false);
  assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:7897\r\n').ok, false);

  const socksBlocked = parseAndValidateProxyUrl('socks5://127.0.0.1:7897');
  assert.equal(socksBlocked.ok, false);
  assert.match(socksBlocked.error, /HTTP \/ Mixed/);

  const okHttp = parseAndValidateProxyUrl('http://127.0.0.1:7897/');
  assert.equal(okHttp.ok, true);
  assert.equal(okHttp.value, 'http://127.0.0.1:7897');
  assert.equal(okHttp.port, 7897);

  const okAuth = parseAndValidateProxyUrl('http://user:secretpass@127.0.0.1:7897');
  assert.equal(okAuth.ok, true);
  assert.equal(okAuth.redacted, 'http://127.0.0.1:7897');
  assert.equal(redactProxyUrl(okAuth.value), 'http://127.0.0.1:7897');

  const okIpv6 = parseAndValidateProxyUrl('http://[::1]:7897');
  assert.equal(okIpv6.ok, true);
  assert.equal(okIpv6.port, 7897);
});

test('sanitizeDiagnosticErrorText: 自动脱敏代理凭据与 Bearer Token', () => {
  const raw = new Error('connect http://alice:supersecret@127.0.0.1:7897 failed Bearer abc.def.ghi access_token=tok123');
  const clean = sanitizeDiagnosticErrorText(raw);
  assert.doesNotMatch(clean, /supersecret/);
  assert.doesNotMatch(clean, /abc\.def\.ghi/);
  assert.doesNotMatch(clean, /tok123/);
  assert.match(clean, /<REDACTED>/);
});

test('ensureLoopbackNoProxy & matchesNoProxy: 强制保留 localhost / 127.0.0.1 / ::1 直连', () => {
  const guaranteed = ensureLoopbackNoProxy('example.internal');
  assert.match(guaranteed, /\blocalhost\b/);
  assert.match(guaranteed, /\b127\.0\.0\.1\b/);
  assert.match(guaranteed, /::1/);
  assert.match(guaranteed, /example\.internal/);

  assert.equal(ensureLoopbackNoProxy(''), DEFAULT_NO_PROXY);
  assert.equal(toChromiumBypassList('localhost,127.0.0.1,<local>'), 'localhost,127.0.0.1,<-loopback>');

  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('api.openai.com'), false);

  assert.equal(matchesNoProxy('localhost', guaranteed), true);
  assert.equal(matchesNoProxy('127.0.0.1', guaranteed), true);
  assert.equal(matchesNoProxy('::1', guaranteed), true);
  assert.equal(matchesNoProxy('chatgpt.com', guaranteed), false);
});

test('checkProxyHealth: 失效端口明确报中文错误且绝不虚报 modelCallVerified', async () => {
  const deadSrv = net.createServer();
  await new Promise((r) => deadSrv.listen(0, '127.0.0.1', r));
  const deadPort = deadSrv.address().port;
  await new Promise((r) => deadSrv.close(r));

  const deadHealth = await checkProxyHealth(`http://127.0.0.1:${deadPort}`, { timeoutMs: 800 });
  assert.equal(deadHealth.configValid, true);
  assert.equal(deadHealth.proxyReachable, false);
  assert.equal(deadHealth.modelCallVerified, false);
  assert.match(deadHealth.error, /代理端口不可达/);
  assert.match(deadHealth.error, /不会静默改为直连/);

  const targetSrv = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  const targetPort = targetSrv.address().port;

  const mockProxy = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  mockProxy.on('connect', (req, clientSock) => {
    const [h, p] = String(req.url).split(':');
    const upstream = net.connect(Number(p), h, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    upstream.on('error', () => clientSock.destroy());
  });
  await new Promise((r) => mockProxy.listen(0, '127.0.0.1', r));
  const proxyPort = mockProxy.address().port;

  try {
    const okHealth = await checkProxyHealth(`http://127.0.0.1:${proxyPort}`, {
      probeConnectHost: '127.0.0.1',
      probeConnectPort: targetPort,
      timeoutMs: 1500
    });
    assert.equal(okHealth.configValid, true);
    assert.equal(okHealth.proxyReachable, true);
    assert.equal(okHealth.tunnelReachable, true);
    assert.equal(okHealth.modelCallVerified, false);
  } finally {
    await Promise.all([
      new Promise((r) => mockProxy.close(r)),
      new Promise((r) => targetSrv.close(r))
    ]);
  }
});
