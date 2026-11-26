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
      }
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
    _mockProxiesRes: { ok: false }
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
