'use strict';
/**
 * Build a clean, portable GitHub Release ZIP archive excluding machine-specific artifacts
 * (generated launcher/, *.lnk, config.json, dist/, .tmp-*) and verify zero personal path leaks.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

const INCLUDE_PATHS = [
  '.github',
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'codex-notun.cmd',
  'codex-notun-https.cmd',
  'codex-notun-tool.cmd',
  '一键安装与配置.cmd',
  '调整自动压缩上限.cmd',
  '配置与生成快捷方式.cmd',
  '诊断检查.cmd',
  '排查10053断连.cmd',
  '一键卸载与还原.cmd',
  'src',
  'scripts',
  'test',
  'plugin-marketplace'
];

const FORBIDDEN_PATTERNS = [
  /C:\\Users\\(?!(?:runneradmin|Administrator|Public|Default|demo|yourname|<user>))[^\\\s"']+/i
];

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (base === 'node_modules' || base === 'dist' || base === 'launcher' || base.startsWith('.tmp-')) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  if (src.endsWith('.lnk') || src.endsWith('.bak') || src.endsWith('.tmp')) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function scanDirectoryForLeaks(dir) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scanDirectoryForLeaks(full));
    } else if (/\.(js|json|md|cmd|bat|vbs|yml|yaml|svg|txt)$/i.test(entry.name)) {
      // Allow tests to reference synthetic/regex check patterns if explicitly in test/plugin-validation.test.js
      if (full.endsWith(path.join('test', 'plugin-validation.test.js'))) continue;
      const content = fs.readFileSync(full, 'utf8');
      for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(content)) {
          hits.push({ file: path.relative(dir, full), pattern: String(re) });
        }
      }
    }
  }
  return hits;
}

function buildReleaseZip() {
  const distDir = path.join(PROJECT_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipName = `codex-no-tun-v${PKG.version}-windows.zip`;
  const zipPath = path.join(distDir, zipName);
  const stageRoot = fs.mkdtempSync(path.join(distDir, '.tmp-stage-'));
  const stagePkgDir = path.join(stageRoot, 'codex-no-tun');

  try {
    fs.mkdirSync(stagePkgDir, { recursive: true });
    for (const rel of INCLUDE_PATHS) {
      const src = path.join(PROJECT_ROOT, rel);
      if (fs.existsSync(src)) {
        copyRecursive(src, path.join(stagePkgDir, rel));
      }
    }

    const leaks = scanDirectoryForLeaks(stagePkgDir);
    if (leaks.length > 0) {
      throw new Error(`隐私审计失败，打包目录中存在本机私有信息: ${JSON.stringify(leaks)}`);
    }

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const psCmd = `Compress-Archive -Path '${stagePkgDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      windowsHide: true,
      stdio: 'pipe'
    });

    const sizeBytes = fs.statSync(zipPath).size;
    console.log(JSON.stringify({ ok: true, zipPath, sizeBytes }, null, 2));
    return { ok: true, zipPath, sizeBytes };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  buildReleaseZip();
}

module.exports = { buildReleaseZip, scanDirectoryForLeaks };
