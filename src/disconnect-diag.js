'use strict';
/**
 * Read-only diagnostics for Codex `os error 10053` / WebSocket stream disconnections
 * and Clash Verge / Mihomo TCP keep-alive stability.
 * Never reads chat messages, prompts, auth tokens, or Clash secrets.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { sanitizeDiagnosticErrorText } = require('./proxy-core');
const { inspectCodexUserConfigReadOnly } = require('./discovery');

const OVERSIZED_CONTEXT_THRESHOLD_BYTES = 2 * 1024 * 1024;

function loadSqliteSync() {
  try {
    const sqlite = require('node:sqlite');
    if (sqlite && typeof sqlite.DatabaseSync === 'function') return sqlite.DatabaseSync;
  } catch {}
  return null;
}

function queryPipeJson(pipePath, reqPath, method = 'GET', bodyObj = null, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      : {};
    const req = http.request({
      socketPath: pipePath,
      path: reqPath,
      method,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: null, json: null, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Strictly read-only query against ~/.codex/logs_2.sqlite for transport errors & payload sizes.
 * Does NOT read chat content, user prompts, or credentials.
 */
function analyzeCodexLogsForDisconnects(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const codexHome = options.codexHome || (env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'));
  const dbPath = options.dbPath || path.join(codexHome, 'logs_2.sqlite');
  const hours = Number.isFinite(Number(options.hours)) && Number(options.hours) > 0 ? Number(options.hours) : 24;
  const nowSec = Number.isFinite(Number(options.nowSec)) ? Number(options.nowSec) : Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - hours * 3600;

  const empty = {
    available: false,
    dbPath,
    hours,
    count10053: 0,
    count10054: 0,
    countWsClosed: 0,
    countHttpFallback: 0,
    maxRequestBytes: 0,
    maxCompressedBytes: 0,
    oversizedContextRisk: false,
    avgDisconnectIntervalSec: null,
    recentEvents: [],
    error: null
  };

  if (!fs.existsSync(dbPath)) {
    return { ...empty, error: '未找到 Codex 日志库 logs_2.sqlite' };
  }

  const DatabaseSync = options.DatabaseSync || loadSqliteSync();
  if (!DatabaseSync) {
    return { ...empty, error: '当前 Node.js 运行时不支持 node:sqlite 只读查询' };
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, ts, level, target, feedback_log_body
      FROM logs
      WHERE ts >= ?
        AND (
          feedback_log_body LIKE '%10053%'
          OR feedback_log_body LIKE '%10054%'
          OR feedback_log_body LIKE '%websocket closed by server%'
          OR feedback_log_body LIKE '%falling back to HTTP%'
          OR feedback_log_body LIKE '%pre_compression_bytes=%'
        )
      ORDER BY id DESC
      LIMIT 400
    `).all(cutoffSec);

    let count10053 = 0;
    let count10054 = 0;
    let countWsClosed = 0;
    let countHttpFallback = 0;
    let maxRequestBytes = 0;
    let maxCompressedBytes = 0;
    const disconnectTimestamps = [];
    const recentEvents = [];

    for (const r of rows) {
      const body = String(r.feedback_log_body || '');
      const ts = Number(r.ts) || 0;
      const is10053 = body.includes('10053');
      const is10054 = body.includes('10054');
      const isWsClosed = body.includes('websocket closed by server');
      const isFallback = body.includes('falling back to HTTP');

      if (is10053) count10053++;
      if (is10054) count10054++;
      if (isWsClosed) countWsClosed++;
      if (isFallback) countHttpFallback++;

      if (is10053 || is10054 || isWsClosed) {
        disconnectTimestamps.push(ts);
        if (recentEvents.length < 10) {
          const tail = body.length > 220 ? body.slice(-220) : body;
          recentEvents.push({
            ts,
            isoTime: ts ? new Date(ts * 1000).toISOString() : null,
            kind: is10053 ? 'os_error_10053' : (is10054 ? 'os_error_10054' : 'ws_closed'),
            target: String(r.target || ''),
            snippet: sanitizeDiagnosticErrorText(tail)
          });
        }
      } else if (isFallback && recentEvents.length < 10) {
        recentEvents.push({
          ts,
          isoTime: ts ? new Date(ts * 1000).toISOString() : null,
          kind: 'http_fallback',
          target: String(r.target || ''),
          snippet: 'falling back to HTTP'
        });
      }

      const preM = body.match(/pre_compression_bytes=(\d+)/);
      if (preM) {
        const b = Number(preM[1]);
        if (b > maxRequestBytes) maxRequestBytes = b;
      }
      const postM = body.match(/post_compression_bytes=(\d+)/);
      if (postM) {
        const b = Number(postM[1]);
        if (b > maxCompressedBytes) maxCompressedBytes = b;
      }
    }

    let avgDisconnectIntervalSec = null;
    if (disconnectTimestamps.length >= 2) {
      const sorted = [...disconnectTimestamps].sort((a, b) => a - b);
      const intervals = [];
      for (let i = 1; i < sorted.length; i++) {
        const diff = sorted[i] - sorted[i - 1];
        if (diff >= 10 && diff <= 600) intervals.push(diff);
      }
      if (intervals.length > 0) {
        avgDisconnectIntervalSec = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
      }
    }

    return {
      available: true,
      dbPath,
      hours,
      count10053,
      count10054,
      countWsClosed,
      countHttpFallback,
      maxRequestBytes,
      maxCompressedBytes,
      oversizedContextRisk: maxRequestBytes >= OVERSIZED_CONTEXT_THRESHOLD_BYTES,
      avgDisconnectIntervalSec,
      recentEvents,
      error: null
    };
  } catch (err) {
    return { ...empty, error: sanitizeDiagnosticErrorText(err) };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

async function inspectClashStabilityReadOnly(options = {}) {
  const pipePath = options.pipePath || '\\\\.\\pipe\\verge-mihomo';
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const logDir = options.clashLogDir || path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev', 'logs');

  const result = {
    pipeReachable: false,
    keepAliveIdle: null,
    keepAliveInterval: null,
    disableKeepAlive: null,
    tcpConcurrent: null,
    tunEnabled: null,
    keepAliveUnset: false,
    activeNodeName: null,
    activeNodeType: null,
    recentNodeDelays: [],
    nodeTimeoutCount: 0,
    latestLogPath: null
  };

  const cfgRes = options._mockConfigsRes || await queryPipeJson(pipePath, '/configs', 'GET');
  if (cfgRes.ok && cfgRes.json) {
    result.pipeReachable = true;
    const c = cfgRes.json;
    result.keepAliveIdle = Number.isFinite(Number(c['keep-alive-idle'])) ? Number(c['keep-alive-idle']) : null;
    result.keepAliveInterval = Number.isFinite(Number(c['keep-alive-interval'])) ? Number(c['keep-alive-interval']) : null;
    result.disableKeepAlive = typeof c['disable-keep-alive'] === 'boolean' ? c['disable-keep-alive'] : null;
    result.tcpConcurrent = typeof c['tcp-concurrent'] === 'boolean' ? c['tcp-concurrent'] : null;
    result.tunEnabled = typeof c.tun?.enable === 'boolean' ? c.tun.enable : null;
    result.keepAliveUnset = Boolean(
      result.disableKeepAlive === true
      || result.keepAliveIdle === 0
      || result.keepAliveInterval === 0
    );
  }

  const proxiesRes = options._mockProxiesRes || await queryPipeJson(pipePath, '/proxies', 'GET');
  if (proxiesRes.ok && proxiesRes.json && proxiesRes.json.proxies) {
    const p = proxiesRes.json.proxies;
    let curName = p['AI']?.now || p['GLOBAL']?.now || null;
    const visited = new Set();
    while (curName && p[curName] && p[curName].now && !visited.has(curName)) {
      visited.add(curName);
      curName = p[curName].now;
    }
    if (curName && p[curName]) {
      result.activeNodeName = curName;
      result.activeNodeType = p[curName].type || null;
      result.recentNodeDelays = Array.isArray(p[curName].history)
        ? p[curName].history.slice(-5).map((h) => ({ time: h.time, delay: h.delay }))
        : [];
    }
  }

  try {
    const logFile = options.clashLogFile || (fs.existsSync(path.join(logDir, 'service', 'service_latest.log'))
      ? path.join(logDir, 'service', 'service_latest.log')
      : null);
    if (logFile && fs.existsSync(logFile)) {
      result.latestLogPath = logFile;
      const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-300);
      for (const line of lines) {
        if (/secret|password|token|auth/i.test(line)) continue;
        if (/level=(warning|error)/i.test(line) && /(i\/o timeout|10053|reset by peer|EOF|context deadline exceeded)/i.test(line)) {
          result.nodeTimeoutCount++;
        }
      }
    }
  } catch {}

  return result;
}

const MIHOMO_KEEPALIVE_KEYS = [
  ['keep-alive-idle', 15],
  ['keep-alive-interval', 15],
  ['disable-keep-alive', false],
  ['tcp-concurrent', true]
];

const MIHOMO_KEEPALIVE_MERGE_YAML = [
  '# Clash Verge Rev -> 设置 -> 全局扩展配置 (Merge) 中加入以下内容以永久生效:',
  'keep-alive-idle: 15',
  'keep-alive-interval: 15',
  'disable-keep-alive: false',
  'tcp-concurrent: true'
].join('\n');

function upsertYamlTopLevelKeys(content, entries) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = content.endsWith('\n') || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailing && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const previous = {};
  const updated = [...lines];

  for (const [key, val] of entries) {
    const newLine = `${key}: ${val}`;
    const idx = updated.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (idx !== -1) {
      previous[key] = { existed: true, line: updated[idx] };
      updated[idx] = newLine;
    } else {
      previous[key] = { existed: false, line: null };
      updated.push(newLine);
    }
  }

  return {
    previous,
    nextContent: updated.join(eol) + (hadTrailing ? eol : '')
  };
}

function restoreYamlTopLevelKeys(content, previousMap) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = content.endsWith('\n') || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailing && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const updated = [...lines];
  for (const [key, info] of Object.entries(previousMap || {})) {
    const idx = updated.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (idx === -1) continue;
    if (info && info.existed && typeof info.line === 'string') {
      updated[idx] = info.line;
    } else {
      updated.splice(idx, 1);
    }
  }
  return updated.length === 0 ? '' : (updated.join(eol) + (hadTrailing ? eol : ''));
}

function syncYamlTunEnableIfFalse(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = content.endsWith('\n') || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailing && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let inTun = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^tun\s*:\s*(#.*)?$/.test(l)) { inTun = true; continue; }
    if (/^[a-zA-Z0-9_-]+\s*:/.test(l) && !/^\s/.test(l)) { inTun = false; }
    if (inTun && /^(\s+enable\s*:\s*)true\b(.*)$/i.test(l)) {
      lines[i] = `${RegExp.$1}false${RegExp.$2}`;
      changed = true;
    }
  }
  return { changed, content: lines.join(eol) + (hadTrailing ? eol : '') };
}

function getDefaultClashVergeDir(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return options.clashDir || path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev');
}

function getDefaultClashStatePath(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return options.stateFile || path.join(localAppData, 'CodexNoTun', 'clash-keepalive-state.json');
}

async function applyPersistentClashKeepAlive(options = {}) {
  const fsImpl = options.fs || fs;
  const clashDir = getDefaultClashVergeDir(options);
  const pipePath = options.pipePath || '\\\\.\\pipe\\verge-mihomo';
  const stateFile = path.resolve(getDefaultClashStatePath(options));
  const backupDir = path.resolve(options.backupDir || path.join(path.dirname(stateFile), 'backups'));
  const idle = Number.isFinite(Number(options.idle)) ? Number(options.idle) : 15;
  const interval = Number.isFinite(Number(options.interval)) ? Number(options.interval) : 15;
  const entries = [
    ['keep-alive-idle', idle],
    ['keep-alive-interval', interval],
    ['disable-keep-alive', false],
    ['tcp-concurrent', true]
  ];

  // Check current live TUN state BEFORE touching/reloading any Clash file so we never re-enable TUN!
  const beforeCfg = options._mockBeforeCfg || await queryPipeJson(pipePath, '/configs', 'GET');
  const liveTunWasFalse = beforeCfg.ok && beforeCfg.json && beforeCfg.json.tun?.enable === false;

  const mergePath = path.join(clashDir, 'profiles', 'Merge.yaml');
  const clashVergeYamlPath = path.join(clashDir, 'clash-verge.yaml');
  const fileRecords = {};
  fsImpl.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const [label, fp] of [['mergeYaml', mergePath], ['clashVergeYaml', clashVergeYamlPath]]) {
    const existed = fsImpl.existsSync(fp);
    if (!existed && label === 'clashVergeYaml') continue;
    const raw = existed ? fsImpl.readFileSync(fp, 'utf8') : '';
    let backupPath = null;
    if (existed) {
      backupPath = path.join(backupDir, `${path.basename(fp)}.${stamp}.bak`);
      fsImpl.writeFileSync(backupPath, raw, 'utf8');
    }
    const merged = upsertYamlTopLevelKeys(raw, entries);
    let finalContent = merged.nextContent;
    let tunSyncedToFalse = false;
    if (label === 'clashVergeYaml' && liveTunWasFalse) {
      const synced = syncYamlTunEnableIfFalse(finalContent);
      finalContent = synced.content;
      tunSyncedToFalse = synced.changed;
    }
    fsImpl.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(tmp, finalContent, 'utf8');
    fsImpl.renameSync(tmp, fp);
    fileRecords[label] = {
      path: fp,
      existedBefore: existed,
      backupPath,
      previous: merged.previous,
      tunSyncedToFalse
    };
  }

  fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmpState = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpState, JSON.stringify({ schemaVersion: 1, files: fileRecords, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  fsImpl.renameSync(tmpState, stateFile);

  let reloadRes = { ok: false, status: null, error: 'clash-verge.yaml 未找到' };
  if (fsImpl.existsSync(clashVergeYamlPath)) {
    reloadRes = options._mockReloadRes || await queryPipeJson(pipePath, '/configs?force=true', 'PUT', { path: clashVergeYamlPath });
  }
  const verifyRes = options._mockVerifyRes || await queryPipeJson(pipePath, '/configs', 'GET');
  const appliedIdle = verifyRes.ok && verifyRes.json ? verifyRes.json['keep-alive-idle'] : null;
  const appliedInterval = verifyRes.ok && verifyRes.json ? verifyRes.json['keep-alive-interval'] : null;
  const appliedDisable = verifyRes.ok && verifyRes.json ? verifyRes.json['disable-keep-alive'] : null;
  const tunAfter = verifyRes.ok && verifyRes.json ? verifyRes.json.tun?.enable : null;

  return {
    ok: Boolean(Object.keys(fileRecords).length > 0),
    reloaded: Boolean(reloadRes.ok),
    reloadError: reloadRes.ok ? null : (reloadRes.error || reloadRes.text || `HTTP ${reloadRes.status}`),
    verified: Boolean(appliedIdle === idle && appliedInterval === interval && appliedDisable === false),
    current: {
      keepAliveIdle: appliedIdle,
      keepAliveInterval: appliedInterval,
      disableKeepAlive: appliedDisable,
      tunEnabled: tunAfter
    },
    files: Object.values(fileRecords).map((r) => ({ path: r.path, backupPath: r.backupPath })),
    stateFile,
    permanentMergeYaml: MIHOMO_KEEPALIVE_MERGE_YAML
  };
}

async function restorePersistentClashKeepAlive(options = {}) {
  const fsImpl = options.fs || fs;
  const stateFile = path.resolve(getDefaultClashStatePath(options));
  if (!fsImpl.existsSync(stateFile)) {
    return { ok: false, error: `未找到 Clash 保活还原记录：${stateFile}` };
  }
  const state = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
  const restoredFiles = [];
  for (const rec of Object.values(state.files || {})) {
    if (!rec || !rec.path || !fsImpl.existsSync(rec.path)) continue;
    const current = fsImpl.readFileSync(rec.path, 'utf8');
    const restored = restoreYamlTopLevelKeys(current, rec.previous);
    const tmp = `${rec.path}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(tmp, restored, 'utf8');
    fsImpl.renameSync(tmp, rec.path);
    restoredFiles.push(rec.path);
  }
  const pipePath = options.pipePath || '\\\\.\\pipe\\verge-mihomo';
  const clashVergePath = state.files?.clashVergeYaml?.path;
  if (clashVergePath && fsImpl.existsSync(clashVergePath) && !options.skipReload) {
    await (options._mockReloadRes || queryPipeJson(pipePath, '/configs?force=true', 'PUT', { path: clashVergePath }));
  }
  try { fsImpl.unlinkSync(stateFile); } catch {}
  return { ok: true, restoredFiles };
}

async function applyRuntimeMihomoKeepAlive(options = {}) {
  const pipePath = options.pipePath || '\\\\.\\pipe\\verge-mihomo';
  const idle = Number.isFinite(Number(options.idle)) ? Number(options.idle) : 15;
  const interval = Number.isFinite(Number(options.interval)) ? Number(options.interval) : 15;

  const patchRes = options._mockPatchRes || await queryPipeJson(pipePath, '/configs', 'PATCH', {
    'keep-alive-idle': idle,
    'keep-alive-interval': interval,
    'disable-keep-alive': false
  });
  const verifyRes = options._mockVerifyRes || await queryPipeJson(pipePath, '/configs', 'GET');

  const appliedIdle = verifyRes.ok && verifyRes.json ? verifyRes.json['keep-alive-idle'] : null;
  const appliedInterval = verifyRes.ok && verifyRes.json ? verifyRes.json['keep-alive-interval'] : null;
  const appliedDisable = verifyRes.ok && verifyRes.json ? verifyRes.json['disable-keep-alive'] : null;

  return {
    ok: Boolean(patchRes.ok),
    status: patchRes.status,
    error: patchRes.ok ? null : (patchRes.error || patchRes.text || `HTTP ${patchRes.status}`),
    verified: Boolean(appliedIdle === idle && appliedInterval === interval && appliedDisable === false),
    current: {
      keepAliveIdle: appliedIdle,
      keepAliveInterval: appliedInterval,
      disableKeepAlive: appliedDisable
    },
    permanentMergeYaml: MIHOMO_KEEPALIVE_MERGE_YAML
  };
}

/**
 * Build process-scoped CLI overrides for HTTPS-only (disables WebSocket, keeps official ChatGPT OAuth
 * and official endpoint without modifying ~/.codex/config.toml or breaking Desktop thread provider bindings).
 */
function buildHttpsOnlyCliArgs() {
  return [
    '-c', 'model_provider="openai-https"',
    '-c', 'model_providers.openai-https.name="OpenAI"',
    '-c', 'model_providers.openai-https.wire_api="responses"',
    '-c', 'model_providers.openai-https.requires_openai_auth=true',
    '-c', 'model_providers.openai-https.supports_websockets=false',
    '-c', 'model_providers.openai-https.supports_standalone_web_search=true',
    '-c', 'model_providers.openai-https.stream_idle_timeout_ms=600000',
    '-c', 'model_providers.openai-https.stream_max_retries=8'
  ];
}

async function diagnoseDisconnectRisk(options = {}) {
  const logs = analyzeCodexLogsForDisconnects(options);
  const clash = await inspectClashStabilityReadOnly(options);
  const codexConfig = inspectCodexUserConfigReadOnly(options);

  const findings = [];
  const recommendations = [];

  if (logs.count10053 > 0 || logs.countWsClosed > 0) {
    findings.push(
      `最近 ${logs.hours} 小时内检测到 ${logs.count10053} 次 os error 10053 中止、${logs.countWsClosed} 次 WebSocket 被断开、` +
      `${logs.countHttpFallback} 次触发 HTTP 回退${logs.avgDisconnectIntervalSec ? `（平均约 ${logs.avgDisconnectIntervalSec} 秒断一次）` : ''}。`
    );
  }
  if (logs.oversizedContextRisk) {
    const mb = (logs.maxRequestBytes / (1024 * 1024)).toFixed(2);
    const zstdMb = logs.maxCompressedBytes ? (logs.maxCompressedBytes / (1024 * 1024)).toFixed(2) : null;
    findings.push(
      `单次请求体过大：最高达 ${mb} MB${zstdMb ? `（HTTPS zstd 压缩后 ${zstdMb} MB）` : ''}。` +
      'Codex 默认 Responses WebSocket 传输大上下文或思考停顿超过约 90 秒时，极易被本地/中间链路判定超时并触发 10053 中止。'
    );
    recommendations.push('【立即可用】在长会话中执行 `/compact` 压缩上下文，或开启新会话继续，避免单轮请求超过 2 MB。');
  }
  if (clash.keepAliveUnset) {
    findings.push(
      `Clash Mihomo 当前 TCP 保活未开启定时探测（keep-alive-idle=${clash.keepAliveIdle}, keep-alive-interval=${clash.keepAliveInterval}），` +
      '长连接在模型长时间思考/工具等待期间容易被中间网关或 Windows 链路断开。'
    );
    recommendations.push(
      '【Clash 保活优化】运行 `codex-notun-tool.cmd fix-keepalive` 立即下发 15s TCP Keep-Alive，并将扩展配置写入 Clash Verge 全局 Merge 配置以永久生效。'
    );
  }
  if (clash.nodeTimeoutCount > 0) {
    findings.push(
      `Clash 最近日志中检测到 ${clash.nodeTimeoutCount} 条节点连接超时/重置告警` +
      `${clash.activeNodeName ? `（当前节点：${clash.activeNodeName}）` : ''}。`
    );
    recommendations.push('【节点稳定性】若频繁出现 `i/o timeout`，请在 Clash Verge 中切换到延迟更稳定或支持多路长连接的节点（避免高丢包/短空闲超时节点）。');
  }
  if (logs.countHttpFallback > 0 || logs.count10053 > 0) {
    recommendations.push(
      '【CLI 免断连模式】使用 `codex-notun.cmd --https-only ...` 可在进程级临时切换为纯 HTTPS+zstd 流式传输（保留 ChatGPT 登录态且不改 ~/.codex/config.toml，避免破坏桌面端已有会话归属）。'
    );
  }
  if (process.platform === 'win32') {
    recommendations.push(
      '【Windows 杀毒/防火墙】Windows `os error 10053`（WSAECONNABORTED）常由本机网络过滤/Microsoft Defender 实时扫描长连接触发；建议按 `codex doctor` 提示为 Codex 应用与 `codex.exe` 添加 Defender 排除项。'
    );
  }

  return {
    logs,
    clash,
    codexConfig,
    findings,
    recommendations,
    permanentMergeYaml: MIHOMO_KEEPALIVE_MERGE_YAML
  };
}

module.exports = {
  OVERSIZED_CONTEXT_THRESHOLD_BYTES,
  MIHOMO_KEEPALIVE_KEYS,
  MIHOMO_KEEPALIVE_MERGE_YAML,
  upsertYamlTopLevelKeys,
  restoreYamlTopLevelKeys,
  analyzeCodexLogsForDisconnects,
  inspectClashStabilityReadOnly,
  applyPersistentClashKeepAlive,
  restorePersistentClashKeepAlive,
  applyRuntimeMihomoKeepAlive,
  buildHttpsOnlyCliArgs,
  diagnoseDisconnectRisk
};
