'use strict';
/**
 * Core proxy validation, loopback bypass normalization, and health diagnostics.
 * Adapted from elviscjn-cjn/antigravity-context-viewer (meter-proxy.js, MIT License,
 * commit c057717d1fc2cbe15ae0ce59287877d054eed4c2).
 */

const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');

const REQUIRED_LOOPBACK_TOKENS = ['localhost', '127.0.0.1', '::1'];
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<local>';

function assertSingleLineSafe(value, fieldName) {
  const s = String(value ?? '');
  if (/[\r\n\0]/.test(s)) {
    throw new Error(`${fieldName} 包含非法控制字符（换行或空字节）`);
  }
  return s;
}

function normalizeProxyUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  return s.replace(/^([a-zA-Z0-9+.-]+:\/\/[^/?#]+)\/+$/, '$1');
}

function redactProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(normalizeProxyUrl(rawUrl));
    if (!u.protocol || !u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(rawUrl).replace(/\/\/[^/@\s]+@/, '//') || null;
  }
}

function sanitizeDiagnosticErrorText(err) {
  const msg = String(err?.message || err || '请求失败');
  return msg
    .replace(/([a-zA-Z0-9+.-]+:\/\/)([^/@\s]+@)/g, '$1')
    .replace(/(code|access_token|refresh_token|id_token|client_secret|authorization)=([^&\s"']+)/gi, '$1=<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <REDACTED>');
}

/**
 * Validate and normalize proxy URL.
 * v1 targets Clash local HTTP / Mixed ports (`http://` and `https://`).
 * SOCKS5 is rejected by default because empirical Codex checks showed mixed HTTP CONNECT / SOCKS5 traffic
 * on different sub-clients unless explicitly tested end-to-end.
 */
function parseAndValidateProxyUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: '代理地址不能为空（示例：http://127.0.0.1:7897）' };
  }
  if (/[\r\n\0]/.test(rawUrl)) {
    return { ok: false, error: '代理地址包含非法控制字符' };
  }
  const trimmed = normalizeProxyUrl(rawUrl);
  try {
    const u = new URL(trimmed);
    const proto = u.protocol.toLowerCase();
    const isSocks = proto === 'socks5:' || proto === 'socks5h:';
    if (isSocks && !options.allowExperimentalSocks5) {
      return {
        ok: false,
        error: '首版仅支持 Clash 的本地 HTTP / Mixed 端口（http:// 或 https://，示例：http://127.0.0.1:7897）；纯 SOCKS5 在当前 Codex 多客户端链路上未全量验证通过'
      };
    }
    const validProto = isSocks
      ? Boolean(options.allowExperimentalSocks5)
      : (proto === 'http:' || proto === 'https:');
    if (!validProto || !u.hostname) {
      return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https)与主机名' };
    }
    const afterProto = trimmed.slice(u.protocol.length + 2);
    const authority = afterProto.split(/[/?#]/)[0];
    const hostPort = authority.includes('@') ? authority.split('@').pop() : authority;
    const colonIdx = hostPort.startsWith('[') ? hostPort.indexOf(']:') : hostPort.lastIndexOf(':');
    let portNum;
    if (colonIdx !== -1) {
      const explicitPort = hostPort.startsWith('[') ? hostPort.slice(colonIdx + 2) : hostPort.slice(colonIdx + 1);
      if (!/^\d+$/.test(explicitPort)) {
        return { ok: false, error: '代理地址格式错误，端口必须为 1-65535 的数字' };
      }
      portNum = Number(explicitPort);
    } else {
      portNum = proto === 'https:' ? 443 : (isSocks ? 1080 : 80);
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: '代理地址格式错误，端口必须在 1-65535 之间' };
    }
    return {
      ok: true,
      value: trimmed,
      redacted: `${proto}//${u.host}`,
      protocol: proto,
      hostname: u.hostname,
      port: portNum,
      username: u.username || '',
      password: u.password || '',
      isSocks
    };
  } catch {
    return { ok: false, error: '代理地址格式错误，请检查协议、主机与端口（示例：http://127.0.0.1:7897）' };
  }
}

function ipToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    num = ((num << 8) | n) >>> 0;
  }
  return num;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

function matchesNoProxy(hostname, noProxyList) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  const raw = String(noProxyList || '').trim();
  if (!raw) return false;

  const hostIp = ipToUint32(host);
  const tokens = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') return true;
    if (token === '<local>' || token === '<-loopback>') {
      if (!host.includes('.') || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      continue;
    }
    if (token.includes('/')) {
      const [netStr, prefixStr] = token.split('/');
      const netIp = ipToUint32(netStr);
      const prefix = Number(prefixStr);
      if (hostIp !== null && netIp !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if ((hostIp & mask) === (netIp & mask)) return true;
      }
      continue;
    }
    let pattern = token;
    const firstColon = pattern.indexOf(':');
    const colonIdx = pattern.lastIndexOf(':');
    if (colonIdx > 0 && firstColon === colonIdx && /^\d+$/.test(pattern.slice(colonIdx + 1)) && !pattern.startsWith('[')) {
      pattern = pattern.slice(0, colonIdx);
    }
    pattern = pattern.replace(/^\[|\]$/g, '');
    if (pattern.startsWith('*.')) pattern = pattern.slice(1);
    if (pattern.startsWith('.')) {
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith('.' + pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Guarantee localhost, 127.0.0.1, and ::1 are always bypassed so OAuth callbacks and local services never route via proxy.
 */
function ensureLoopbackNoProxy(rawNoProxy) {
  if (rawNoProxy === undefined || rawNoProxy === null || !String(rawNoProxy).trim()) {
    return DEFAULT_NO_PROXY;
  }
  const clean = assertSingleLineSafe(String(rawNoProxy).trim(), 'noProxy');
  const tokens = clean.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const lowerSet = new Set(tokens.map((t) => t.toLowerCase()));
  const prefix = [];
  for (const reqToken of REQUIRED_LOOPBACK_TOKENS) {
    if (!lowerSet.has(reqToken)) {
      prefix.push(reqToken);
      lowerSet.add(reqToken);
    }
  }
  return [...prefix, ...tokens].join(',');
}

function toChromiumBypassList(noProxyStr) {
  return String(noProxyStr || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.toLowerCase() === '<local>' ? '<-loopback>' : s))
    .join(',');
}

function checkTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, err = null) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({
        ok,
        durationMs: Date.now() - started,
        error: err ? sanitizeDiagnosticErrorText(err) : null,
        code: err?.code || null
      });
    };
    socket.setTimeout(timeoutMs, () => {
      const e = new Error(`连接代理端口超时 (${host}:${port}, ${timeoutMs}ms)`);
      e.code = 'ETIMEDOUT';
      finish(false, e);
    });
    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(false, err));
  });
}

function openHttpConnectTunnel(proxyParsed, targetHost, targetPort, timeoutMs = 5000, proxyTlsOpts = {}) {
  return new Promise((resolve, reject) => {
    const httpMod = proxyParsed.protocol === 'https:' ? https : http;
    let settled = false;
    const reqHeaders = {};
    if (proxyParsed.username || proxyParsed.password) {
      const cred = `${decodeURIComponent(proxyParsed.username || '')}:${decodeURIComponent(proxyParsed.password || '')}`;
      reqHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;
    }
    const connectOpts = {
      host: proxyParsed.hostname,
      port: proxyParsed.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: reqHeaders
    };
    if (proxyParsed.protocol === 'https:') {
      if (proxyTlsOpts.ca) connectOpts.ca = proxyTlsOpts.ca;
      if (typeof proxyTlsOpts.rejectUnauthorized === 'boolean') {
        connectOpts.rejectUnauthorized = proxyTlsOpts.rejectUnauthorized;
      }
    }
    const connectReq = httpMod.request(connectOpts);
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    connectReq.on('connect', (res, socket) => {
      if (settled) {
        try { socket.destroy(); } catch {}
        return;
      }
      if (res.statusCode === 200) {
        settled = true;
        resolve(socket);
      } else {
        try { socket.destroy(); } catch {}
        finishErr(new Error(`HTTP 代理 CONNECT 失败: HTTP ${res.statusCode}`));
      }
    });
    connectReq.on('error', (err) => {
      finishErr(new Error(`HTTP 代理连接失败: ${sanitizeDiagnosticErrorText(err)}`));
    });
    connectReq.setTimeout(timeoutMs, () => {
      try { connectReq.destroy(); } catch {}
      finishErr(new Error(`HTTP 代理 CONNECT 超时 (${timeoutMs}ms)`));
    });
    connectReq.end();
  });
}

/**
 * Send a request strictly through the specified HTTP/HTTPS proxy (bypassing only loopback/NO_PROXY).
 * Never silently falls back to direct on proxy failure.
 */
function requestViaProxy(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const timeoutMs = Number(options.timeoutMs) || 8000;
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const targetPort = Number(parsedUrl.port) || (isHttps ? 443 : 80);
      const noProxy = ensureLoopbackNoProxy(options.noProxy);
      const loopback = isLoopbackHost(parsedUrl.hostname);
      const bypassMatched = loopback || matchesNoProxy(parsedUrl.hostname, noProxy);

      if (bypassMatched) {
        const transport = isHttps ? https : http;
        const req = transport.request({
          hostname: parsedUrl.hostname,
          port: targetPort,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method: options.method || 'GET',
          headers: options.headers || {},
          rejectUnauthorized: options.rejectUnauthorized
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 400,
              status: res.statusCode,
              text: Buffer.concat(chunks).toString('utf8'),
              route: loopback ? 'loopback_direct' : 'no_proxy_direct'
            });
          });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`直连请求超时 (${timeoutMs}ms)`)));
        req.on('error', reject);
        req.end();
        return;
      }

      const checked = parseAndValidateProxyUrl(options.proxyUrl, options);
      if (!checked.ok) {
        return reject(new Error(checked.error));
      }

      openHttpConnectTunnel(checked, parsedUrl.hostname, targetPort, timeoutMs, options.proxyTlsOpts || {})
        .then((tunnelSocket) => {
          const transport = isHttps ? https : http;
          const tunnelAgent = new transport.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => {
            if (!isHttps) return tunnelSocket;
            const tlsOpts = { socket: tunnelSocket, servername: parsedUrl.hostname };
            if (options.ca) tlsOpts.ca = options.ca;
            if (typeof options.rejectUnauthorized === 'boolean') tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
            return tls.connect(tlsOpts);
          };
          const req = transport.request({
            hostname: parsedUrl.hostname,
            port: targetPort,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: tunnelAgent
          }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 400,
                status: res.statusCode,
                text: Buffer.concat(chunks).toString('utf8'),
                route: 'http_connect_proxy',
                proxyEndpoint: checked.redacted
              });
            });
          });
          req.setTimeout(timeoutMs, () => req.destroy(new Error(`经代理请求超时 (${timeoutMs}ms)`)));
          req.on('error', (err) => {
            try { tunnelSocket.destroy(); } catch {}
            reject(err);
          });
          req.end();
        })
        .catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Layered proxy health check:
 * 1) configValid: URL syntax & supported protocol
 * 2) proxyReachable: TCP listen check on proxy host:port
 * 3) tunnelReachable (optional when probeUrl or probeConnectTarget is provided): CONNECT/HTTP probe
 * 4) modelCallVerified: ALWAYS false here (only a real chat turn can verify model streaming)
 */
async function checkProxyHealth(rawProxyUrl, options = {}) {
  const checked = parseAndValidateProxyUrl(rawProxyUrl, options);
  if (!checked.ok) {
    return {
      configValid: false,
      proxyReachable: false,
      tunnelReachable: null,
      modelCallVerified: false,
      proxyEndpoint: redactProxyUrl(rawProxyUrl),
      error: checked.error
    };
  }

  const tcp = await checkTcpPort(checked.hostname, checked.port, Number(options.timeoutMs) || 2000);
  if (!tcp.ok) {
    return {
      configValid: true,
      proxyReachable: false,
      tunnelReachable: false,
      modelCallVerified: false,
      proxyEndpoint: checked.redacted,
      error: `代理端口不可达 (${checked.redacted})：${tcp.error || '连接被拒绝或超时'}。请确认 Clash / Mihomo 正在运行且端口未更改（不会静默改为直连）。`
    };
  }

  let tunnelReachable = null;
  let tunnelError = null;
  if (options.probeUrl) {
    try {
      const resp = await requestViaProxy(options.probeUrl, {
        proxyUrl: checked.value,
        noProxy: options.noProxy,
        timeoutMs: Number(options.probeTimeoutMs) || 5000,
        rejectUnauthorized: options.rejectUnauthorized
      });
      tunnelReachable = Boolean(resp.ok);
      if (!resp.ok) tunnelError = `代理探测返回 HTTP ${resp.status}`;
    } catch (err) {
      tunnelReachable = false;
      tunnelError = sanitizeDiagnosticErrorText(err);
    }
  } else if (options.probeConnectHost) {
    try {
      const sock = await openHttpConnectTunnel(
        checked,
        options.probeConnectHost,
        Number(options.probeConnectPort) || 443,
        Number(options.probeTimeoutMs) || 5000
      );
      try { sock.destroy(); } catch {}
      tunnelReachable = true;
    } catch (err) {
      tunnelReachable = false;
      tunnelError = sanitizeDiagnosticErrorText(err);
    }
  }

  return {
    configValid: true,
    proxyReachable: true,
    tunnelReachable,
    modelCallVerified: false,
    proxyEndpoint: checked.redacted,
    durationMs: tcp.durationMs,
    error: tunnelError
  };
}

function vbsString(val) {
  const parts = assertSingleLineSafe(val, 'vbsString').split(/([^\x20-\x7e])/).filter(Boolean);
  return parts.map((part) => (/^[\x20-\x7e]+$/.test(part)
    ? `"${part.replace(/"/g, '""')}"`
    : `ChrW(&H${part.charCodeAt(0).toString(16).padStart(4, '0')})`)).join(' & ') || '""';
}

module.exports = {
  REQUIRED_LOOPBACK_TOKENS,
  DEFAULT_NO_PROXY,
  assertSingleLineSafe,
  normalizeProxyUrl,
  redactProxyUrl,
  sanitizeDiagnosticErrorText,
  parseAndValidateProxyUrl,
  isLoopbackHost,
  matchesNoProxy,
  ensureLoopbackNoProxy,
  toChromiumBypassList,
  checkTcpPort,
  openHttpConnectTunnel,
  requestViaProxy,
  checkProxyHealth,
  vbsString
};
