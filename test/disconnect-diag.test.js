'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {}
const {
  analyzeCodexLogsForDisconnects,
  inspectClashStabilityReadOnly,
  applyPersistentClashKeepAlive,
  restorePersistentClashKeepAlive,
  applyRuntimeMihomoKeepAlive,
  buildHttpsOnlyCliArgs,
  diagnoseDisconnectRisk
} = require('../src/disconnect-diag');

test('analyzeCodexLogsForDisconnects: 只读解析 10053/WS 断连/HTTP 回退与超大上下文体积并脱敏', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-10053-db-'));
  try {
    const dbPath = path.join(tempRoot, 'logs_2.sqlite');
    if (!DatabaseSync) {
      fs.writeFileSync(dbPath, 'stub', 'utf8');
      const fallbackRes = analyzeCodexLogsForDisconnects({ dbPath, hours: 24 });
      assert.equal(fallbackRes.available, false);
      assert.match(fallbackRes.error, /node:sqlite/);
      return;
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        level TEXT,
        target TEXT,
        feedback_log_body TEXT
      );
    `);
    const nowSec = 1795670000;
    const insert = db.prepare('INSERT INTO logs (ts, level, target, feedback_log_body) VALUES (?, ?, ?, ?)');
    insert.run(nowSec - 300, 'WARN', 'codex_core::responses_retry', 'sampling_error=stream disconnected before completion: IO error: os error 10053 Bearer secret_tok_123');
    insert.run(nowSec - 210, 'WARN', 'codex_core::responses_retry', 'sampling_error=stream disconnected before completion: websocket closed by server before response.completed');
    insert.run(nowSec - 120, 'WARN', 'codex_core::responses_retry', 'sampling_error=stream disconnected before completion: IO error: os error 10053');
    insert.run(nowSec - 60, 'WARN', 'codex_core::client', 'falling back to HTTP');
    insert.run(nowSec - 59, 'DEBUG', 'codex_http_client::request', 'Compressed request body with zstd pre_compression_bytes=9652154 post_compression_bytes=6627137');
    db.close();

    const res = analyzeCodexLogsForDisconnects({ dbPath, hours: 24, nowSec });
    assert.equal(res.available, true);
    assert.equal(res.count10053, 2);
    assert.equal(res.countWsClosed, 1);
    assert.equal(res.countHttpFallback, 1);
    assert.equal(res.maxRequestBytes, 9652154);
    assert.equal(res.maxCompressedBytes, 6627137);
    assert.equal(res.oversizedContextRisk, true);
    assert.equal(res.avgDisconnectIntervalSec, 90);
    assert.equal(res.recentEvents.some((e) => e.snippet.includes('secret_tok_123')), false);
    assert.equal(res.recentEvents.some((e) => e.snippet.includes('<REDACTED>')), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('inspectClashStabilityReadOnly & applyRuntimeMihomoKeepAlive: 识别保活未开启与节点超时', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-clash-stab-'));
  try {
    const logFile = path.join(tempRoot, 'service_latest.log');
    fs.writeFileSync(logFile, [
      'time="2026-11-26T18:54:16+08:00" level=warning msg="[TCP] dial AI error: i/o timeout"',
      'time="2026-11-26T18:55:00+08:00" level=info msg="[TCP] normal"'
    ].join('\n'), 'utf8');

    const stab = await inspectClashStabilityReadOnly({
      clashLogFile: logFile,
      _mockConfigsRes: {
        ok: true,
        json: {
          'keep-alive-idle': 0,
          'keep-alive-interval': 0,
          'disable-keep-alive': false,
          'tcp-concurrent': true,
          tun: { enable: false }
        }
      },
      _mockProxiesRes: {
        ok: true,
        json: {
          proxies: {
            AI: { now: '节点A' },
            '节点A': { type: 'Shadowsocks', history: [{ time: 't1', delay: 149 }] }
          }
        }
      },
      _mockConnectionsRes: { ok: false }
    });

    assert.equal(stab.pipeReachable, true);
    assert.equal(stab.keepAliveUnset, true);
    assert.equal(stab.activeNodeName, '节点A');
    assert.equal(stab.nodeTimeoutCount, 1);

    const applied = await applyRuntimeMihomoKeepAlive({
      _mockPatchRes: { ok: true, status: 204, text: '' },
      _mockVerifyRes: {
        ok: true,
        json: { 'keep-alive-idle': 15, 'keep-alive-interval': 15, 'disable-keep-alive': false }
      }
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.verified, true);
    assert.match(applied.permanentMergeYaml, /keep-alive-idle: 15/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildHttpsOnlyCliArgs & diagnoseDisconnectRisk: 保留官方认证不改 base_url、生成完整中文建议', async () => {
  const args = buildHttpsOnlyCliArgs();
  const joined = args.join(' ');
  assert.match(joined, /model_provider="openai-https"/);
  assert.match(joined, /supports_websockets=false/);
  assert.match(joined, /requires_openai_auth=true/);
  assert.match(joined, /stream_idle_timeout_ms=600000/);
  assert.doesNotMatch(joined, /base_url/);

  const diag = await diagnoseDisconnectRisk({
    dbPath: path.join(os.tmpdir(), 'nonexistent-logs-db.sqlite'),
    _mockConfigsRes: {
      ok: true,
      json: { 'keep-alive-idle': 0, 'keep-alive-interval': 0, 'disable-keep-alive': false }
    },
    _mockProxiesRes: { ok: false },
    _mockConnectionsRes: { ok: false }
  });
  assert.equal(diag.clash.keepAliveUnset, true);
  assert.equal(diag.findings.some((f) => f.includes('TCP 保活')), true);
});

test('applyPersistentClashKeepAlive & restorePersistentClashKeepAlive: 保留代理节点/TUN=false 并可无损还原', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-clash-persist-'));
  try {
    const clashDir = path.join(tempRoot, 'clash');
    const profilesDir = path.join(clashDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const mergePath = path.join(profilesDir, 'Merge.yaml');
    const cvPath = path.join(clashDir, 'clash-verge.yaml');
    const stateFile = path.join(tempRoot, 'state.json');

    fs.writeFileSync(mergePath, '# Profile Enhancement\nprofile:\n  store-selected: true\n', 'utf8');
    fs.writeFileSync(cvPath, 'mixed-port: 7897\ntun:\n  enable: true\nsecret: keep-untouched\n', 'utf8');

    const res = await applyPersistentClashKeepAlive({
      clashDir,
      stateFile,
      _mockBeforeCfg: { ok: true, json: { tun: { enable: false } } },
      _mockReloadRes: { ok: true, status: 204, text: '' },
      _mockVerifyRes: {
        ok: true,
        json: { 'keep-alive-idle': 15, 'keep-alive-interval': 15, 'disable-keep-alive': false, tun: { enable: false } }
      }
    });
    assert.equal(res.ok, true);
    assert.equal(res.reloaded, true);
    assert.equal(res.verified, true);
    const mergeAfter = fs.readFileSync(mergePath, 'utf8');
    assert.match(mergeAfter, /keep-alive-idle: 15/);
    assert.match(mergeAfter, /store-selected: true/);
    const cvAfter = fs.readFileSync(cvPath, 'utf8');
    assert.match(cvAfter, /keep-alive-idle: 15/);
    assert.match(cvAfter, /enable: false/);
    assert.match(cvAfter, /secret: keep-untouched/);

    fs.appendFileSync(mergePath, 'user-custom-key: true\n', 'utf8');
    const restored = await restorePersistentClashKeepAlive({ stateFile, skipReload: true });
    assert.equal(restored.ok, true);
    const mergeRestored = fs.readFileSync(mergePath, 'utf8');
    assert.doesNotMatch(mergeRestored, /keep-alive-idle/);
    assert.match(mergeRestored, /user-custom-key: true/);
    assert.match(mergeRestored, /store-selected: true/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('diagnoseDisconnectRisk: 识别含大图 120s error sending request 超时与慢速上传节点', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-120s-diag-'));
  try {
    const dbPath = path.join(tempRoot, 'logs_2.sqlite');
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER,
          level TEXT,
          target TEXT,
          feedback_log_body TEXT
        );
      `);
      const nowSec = 1795670000;
      const insert = db.prepare('INSERT INTO logs (ts, level, target, feedback_log_body) VALUES (?, ?, ?, ?)');
      insert.run(nowSec - 300, 'TRACE', 'codex_core::session::turn', 'post sampling token usage total_usage_tokens=77134 auto_compact_scope_limit=Some(120000)');
      insert.run(nowSec - 299, 'DEBUG', 'codex_http_client::request', 'Compressed request body with zstd pre_compression_bytes=3459250 post_compression_bytes=2469738 compression_duration_ms=9');
      insert.run(nowSec - 178, 'DEBUG', 'codex_http_client::client', 'Request failed method=POST url=https://chatgpt.com/backend-api/codex/responses error=error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
      insert.run(nowSec - 57, 'DEBUG', 'codex_http_client::client', 'Request failed method=POST url=https://chatgpt.com/backend-api/codex/responses error=error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
      insert.run(nowSec - 57, 'WARN', 'codex_core::responses_retry', 'stream disconnected - retrying sampling request (1/8 in 190ms)... sampling_error=stream disconnected before completion: error sending request');
      insert.run(nowSec + 64, 'DEBUG', 'codex_http_client::client', 'Request failed method=POST url=https://chatgpt.com/backend-api/codex/responses error=error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
      db.close();

      const nowMs = Date.parse('2026-11-26T23:06:00+08:00');
      const diag = await diagnoseDisconnectRisk({
        dbPath,
        hours: 24,
        nowSec: nowSec + 100,
        nowMs,
        clashLogFile: path.join(tempRoot, 'missing.log'),
        _mockConfigsRes: {
          ok: true,
          json: { 'keep-alive-idle': 15, 'keep-alive-interval': 15, 'disable-keep-alive': false, tun: { enable: false } }
        },
        _mockProxiesRes: {
          ok: true,
          json: {
            proxies: {
              AI: { now: '节点B' },
              '节点B': { type: 'Shadowsocks', history: [{ time: 't1', delay: 180 }] }
            }
          }
        },
        _mockConnectionsRes: {
          ok: true,
          json: {
            connections: [
              {
                metadata: { host: 'chatgpt.com', process: 'Codex.exe' },
                chains: ['节点B', 'AI'],
                upload: 360 * 1024,
                download: 3 * 1024,
                start: '2026-11-26T23:05:48+08:00'
              }
            ]
          }
        }
      });

      assert.equal(diag.logs.countSendRequestError, 3);
      assert.equal(diag.logs.countSendRequestRetries, 1);
      assert.equal(diag.logs.avgSendRequestIntervalSec, 121);
      assert.equal(diag.logs.uploadTimeout120sLikely, true);
      assert.equal(diag.logs.likelyImageHeavyPayload, true);
      assert.equal(diag.logs.latestTokens, 77134);
      assert.equal(diag.logs.latestAutoCompactLimit, 120000);
      assert.equal(diag.clash.activeCodexConnections, 1);
      assert.equal(diag.clash.estimatedUploadKBps, 30);
      assert.equal(diag.clash.slowUploadWarning, true);
      assert.equal(diag.findings.some((f) => f.includes('120 秒')), true);
      assert.equal(diag.findings.some((f) => f.includes('base64')), true);
      assert.equal(diag.recommendations.some((r) => r.includes('/compact')), true);
      assert.equal(diag.recommendations.some((r) => r.includes('节点B')), true);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
