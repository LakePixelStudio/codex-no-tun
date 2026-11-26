'use strict';
/**
 * Process-scoped launch spec builders and standalone Windows No-TUN VBS/.lnk generator.
 * Adapted from elviscjn-cjn/antigravity-context-viewer (meter-proxy.js, MIT License,
 * commit c057717d1fc2cbe15ae0ce59287877d054eed4c2).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  DEFAULT_NO_PROXY,
  assertSingleLineSafe,
  parseAndValidateProxyUrl,
  ensureLoopbackNoProxy,
  toChromiumBypassList,
  redactProxyUrl,
  vbsString
} = require('./proxy-core');
const { detectProxyConfig, detectCodexInstallations, resolveNodeExecutable } = require('./discovery');

function applyProxyVarsToEnv(targetEnv, proxyUrl, noProxy) {
  const checked = parseAndValidateProxyUrl(proxyUrl);
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const safeProxy = assertSingleLineSafe(checked.value, 'proxyUrl');
  const safeNoProxy = ensureLoopbackNoProxy(noProxy);

  delete targetEnv.ELECTRON_RUN_AS_NODE;
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    targetEnv[k] = safeProxy;
  }
  targetEnv.NO_PROXY = safeNoProxy;
  targetEnv.no_proxy = safeNoProxy;
  targetEnv.NODE_USE_ENV_PROXY = '1';
  targetEnv.CODEX_NO_TUN_LAUNCH = '1';
  return { proxyUrl: safeProxy, noProxy: safeNoProxy, env: targetEnv };
}

function buildDesktopLaunchSpec(options = {}) {
  const detected = detectProxyConfig(options.proxyConfigOptions || {});
  const rawUrl = options.proxyUrl && String(options.proxyUrl).trim()
    ? String(options.proxyUrl).trim()
    : (detected.enabled ? detected.proxyUrl : '');
  const checked = parseAndValidateProxyUrl(rawUrl);
  if (!checked.ok) {
    throw new Error(checked.error || '请提供有效的本地代理地址（例如 http://127.0.0.1:7897）');
  }
  const noProxy = ensureLoopbackNoProxy(
    options.noProxy !== undefined ? options.noProxy : (detected.noProxy || DEFAULT_NO_PROXY)
  );
  const chromiumBypass = toChromiumBypassList(noProxy);

  const env = Object.assign({}, options.baseEnv || process.env);
  applyProxyVarsToEnv(env, checked.value, noProxy);

  const args = [
    `--proxy-server=${checked.value}`,
    `--proxy-bypass-list=${chromiumBypass}`
  ];
  if (Array.isArray(options.extraArgs)) {
    for (const a of options.extraArgs) {
      if (typeof a === 'string' && a.length > 0) {
        args.push(assertSingleLineSafe(a, 'extraArg'));
      }
    }
  }

  return {
    proxyUrl: checked.value,
    redactedProxyUrl: checked.redacted,
    noProxy,
    chromiumBypass,
    env,
    args
  };
}

function buildCliProxyEnv(baseEnv = process.env, options = {}) {
  const detected = detectProxyConfig(options.proxyConfigOptions || {});
  const rawUrl = options.proxyUrl && String(options.proxyUrl).trim()
    ? String(options.proxyUrl).trim()
    : (detected.enabled ? detected.proxyUrl : '');
  const checked = parseAndValidateProxyUrl(rawUrl);
  if (!checked.ok) {
    throw new Error(checked.error || '请提供有效的本地代理地址（例如 http://127.0.0.1:7897）');
  }
  const noProxy = ensureLoopbackNoProxy(
    options.noProxy !== undefined ? options.noProxy : (detected.noProxy || DEFAULT_NO_PROXY)
  );

  const env = Object.assign({}, baseEnv);
  applyProxyVarsToEnv(env, checked.value, noProxy);
  delete env.NO_COLOR;
  if (options.nodeExe) {
    const nodeDir = path.dirname(options.nodeExe);
    const currentPath = env.PATH || env.Path || '';
    if (!currentPath.toLowerCase().includes(nodeDir.toLowerCase())) {
      env.PATH = `${nodeDir};${currentPath}`;
    }
  }
  return env;
}

/**
 * Pure ASCII VBScript launcher (compatible with any Windows locale / codepage via ChrW)
 * with running-instance guard, preflight proxy reachability check (fail-closed),
 * and process-scoped proxy env + Chromium args.
 */
function generateWindowsNoTunVbs({
  exePath,
  proxyUrl,
  noProxy,
  preflightNodePath = null,
  preflightCliPath = null
}) {
  const checked = parseAndValidateProxyUrl(proxyUrl);
  if (!checked.ok) throw new Error(checked.error || '无效的代理地址');
  if (!exePath || typeof exePath !== 'string' || !exePath.trim()) {
    throw new Error('缺少 Codex Desktop 可执行文件路径');
  }

  const normalizedBypass = ensureLoopbackNoProxy(noProxy);
  const chromiumBypass = toChromiumBypassList(normalizedBypass);

  const safeExe = vbsString(exePath.trim());
  const safeProxy = vbsString(checked.value);
  const safeRedacted = vbsString(checked.redacted);
  const safeBypass = vbsString(normalizedBypass);
  const safeChromiumBypass = vbsString(chromiumBypass);
  const safeNode = preflightNodePath ? vbsString(preflightNodePath) : '""';
  const safeCli = preflightCliPath ? vbsString(preflightCliPath) : '""';

  const msgMissing = vbsString('未找到 Codex Desktop 启动入口：');
  const msgRunning = vbsString('检测到 Codex 桌面版或后台服务正在运行。请先完全退出 Codex（包括系统托盘图标中的退出），然后再双击此启动器，否则新代理配置无法生效。');
  const msgDeadProxy = vbsString(`本地代理不可用 (${checked.redacted})，已中止启动（不会静默改为直连）。请先启动 Clash / Mihomo 并保持 HTTP / Mixed 端口运行。`);
  const msgTitle = vbsString('Codex 免 TUN 启动器');

  return [
    'Option Explicit',
    'Dim proxyUrl, redactedProxy, noProxy, chromiumBypass, exePath, preflightNode, preflightCli',
    'Dim fso, shell, env, cmd, i, arg, extraArgs, wmi, proc, procName, procCmd, psTcpCmd, tcpRc, preRc',
    `proxyUrl = ${safeProxy}`,
    `redactedProxy = ${safeRedacted}`,
    `noProxy = ${safeBypass}`,
    `chromiumBypass = ${safeChromiumBypass}`,
    `exePath = ${safeExe}`,
    `preflightNode = ${safeNode}`,
    `preflightCli = ${safeCli}`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    'extraArgs = ""',
    'For i = 0 To WScript.Arguments.Count - 1',
    '  arg = WScript.Arguments(i)',
    '  extraArgs = extraArgs & " """ & Replace(arg, """", """""") & """"',
    'Next',
    'If Not fso.FileExists(exePath) Then',
    `  MsgBox ${msgMissing} & vbCrLf & exePath, vbExclamation, ${msgTitle}`,
    '  WScript.Quit 1',
    'End If',
    'On Error Resume Next',
    'Set wmi = GetObject("winmgmts:root\\cimv2")',
    'For Each proc In wmi.ExecQuery("SELECT Name, CommandLine FROM Win32_Process WHERE Name = ""ChatGPT.exe"" OR Name = ""Codex.exe"" OR Name = ""codex.exe""")',
    '  procName = LCase(CStr(proc.Name))',
    '  procCmd = CStr(proc.CommandLine)',
    '  If (procName = "chatgpt.exe" Or procName = "codex.exe") And InStr(1, procCmd, "--type=", 1) = 0 Then',
    '    If procName <> "codex.exe" Or InStr(1, procCmd, "app-server", 1) > 0 Then',
    `      MsgBox ${msgRunning}, vbExclamation, ${msgTitle}`,
    '      WScript.Quit 2',
    '    End If',
    '  End If',
    'Next',
    'On Error GoTo 0',
    'preRc = -1',
    'If preflightNode <> "" And preflightCli <> "" Then',
    '  If fso.FileExists(preflightNode) And fso.FileExists(preflightCli) Then',
    '    preRc = shell.Run("""" & preflightNode & """ """ & preflightCli & """ preflight --proxy """ & proxyUrl & """", 0, True)',
    '  End If',
    'End If',
    'If preRc = -1 Then',
    `  psTcpCmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command ""try { $c = New-Object System.Net.Sockets.TcpClient; $ar = $c.BeginConnect('${assertSingleLineSafe(checked.hostname, 'hostname')}', ${checked.port}, $null, $null); if ($ar.AsyncWaitHandle.WaitOne(2000, $false)) { $c.EndConnect($ar); $c.Close(); exit 0 } else { $c.Close(); exit 1 } } catch { exit 1 }"""`,
    '  preRc = shell.Run(psTcpCmd, 0, True)',
    'End If',
    'If preRc <> 0 Then',
    `  MsgBox ${msgDeadProxy}, vbCritical, ${msgTitle}`,
    '  WScript.Quit 3',
    'End If',
    'Set env = shell.Environment("PROCESS")',
    'env("HTTP_PROXY") = proxyUrl',
    'env("http_proxy") = proxyUrl',
    'env("HTTPS_PROXY") = proxyUrl',
    'env("https_proxy") = proxyUrl',
    'env("ALL_PROXY") = proxyUrl',
    'env("all_proxy") = proxyUrl',
    'env("NO_PROXY") = noProxy',
    'env("no_proxy") = noProxy',
    'env("NODE_USE_ENV_PROXY") = "1"',
    'env("CODEX_NO_TUN_LAUNCH") = "1"',
    'env.Remove("ELECTRON_RUN_AS_NODE")',
    'cmd = """" & exePath & """ --proxy-server=""" & proxyUrl & """ --proxy-bypass-list=""" & chromiumBypass & """" & extraArgs',
    'shell.Run cmd, 1, False',
    ''
  ].join('\r\n');
}

function createShortcutLnk({
  lnkPath,
  vbsPath,
  iconTarget,
  workDir,
  description,
  _execFileSync = execFileSync
}) {
  // Use UTF-16 IShellLinkW + IPersistFile via -EncodedCommand so non-ASCII (.lnk / paths)
  // work reliably even on en-US / CP1252 Windows locales (unlike WScript.Shell.CreateShortcut).
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Runtime.InteropServices.ComTypes;',
    'using System.Text;',
    '[ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class CodexNoTunShellLink {}',
    '[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]',
    'public interface ICodexNoTunShellLinkW {',
    '  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);',
    '  void GetIDList(out IntPtr ppidl); void SetIDList(IntPtr pidl);',
    '  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);',
    '  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
    '  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);',
    '  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);',
    '  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);',
    '  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);',
    '  void GetHotkey(out short pwHotkey); void SetHotkey(short wHotkey);',
    '  void GetShowCmd(out int piShowCmd); void SetShowCmd(int iShowCmd);',
    '  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);',
    '  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);',
    '  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);',
    '  void Resolve(IntPtr hwnd, int fFlags);',
    '  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);',
    '}',
    'public static class CodexNoTunShortcutHelper {',
    '  public static void Save(string lnkPath, string target, string args, string workDir, string iconPath, string desc) {',
    '    var link = (ICodexNoTunShellLinkW)new CodexNoTunShellLink();',
    '    link.SetPath(target);',
    '    if (!string.IsNullOrEmpty(args)) link.SetArguments(args);',
    '    if (!string.IsNullOrEmpty(workDir)) link.SetWorkingDirectory(workDir);',
    '    if (!string.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);',
    '    if (!string.IsNullOrEmpty(desc)) link.SetDescription(desc);',
    '    ((IPersistFile)link).Save(lnkPath, true);',
    '  }',
    '}',
    '"@',
    '$lnk = $env:CODEX_LNK_PATH',
    '$dir = Split-Path -Parent $lnk',
    'if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }',
    '$target = "$env:WINDIR\\System32\\wscript.exe"',
    '$args = "`"$($env:CODEX_VBS_PATH)`""',
    '[CodexNoTunShortcutHelper]::Save($lnk, $target, $args, $env:CODEX_WORK_DIR, $env:CODEX_ICON_PATH, $env:CODEX_LNK_DESC)'
  ].join('\n');

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  _execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      CODEX_LNK_PATH: path.resolve(lnkPath),
      CODEX_VBS_PATH: path.resolve(vbsPath),
      CODEX_WORK_DIR: workDir || path.dirname(vbsPath),
      CODEX_ICON_PATH: iconTarget || '',
      CODEX_LNK_DESC: description || 'Launch Codex Desktop via local proxy (No-TUN)'
    })
  });
  return path.resolve(lnkPath);
}

function createStandaloneNoTunLauncher(options = {}) {
  const fsImpl = options.fs || fs;
  const installs = options.installations || detectCodexInstallations(options);
  const exePath = options.exePath || installs.desktop.preferredTarget;
  if (!exePath) {
    throw new Error('未检测到 Codex Desktop（请确认已安装 Windows Store/MSIX 版 Codex 或通过 --exe 指定路径）');
  }
  const spec = buildDesktopLaunchSpec(options);

  const outDir = path.resolve(options.outDir || path.join(process.cwd(), 'launcher'));
  fsImpl.mkdirSync(outDir, { recursive: true });
  const vbsPath = path.join(outDir, 'launch-codex-no-tun.vbs');

  const nodeExe = options.preflightNodePath !== undefined ? options.preflightNodePath : resolveNodeExecutable(options);
  const cliJs = options.preflightCliPath !== undefined ? options.preflightCliPath : path.resolve(__dirname, 'cli.js');

  const vbsContent = generateWindowsNoTunVbs({
    exePath,
    proxyUrl: spec.proxyUrl,
    noProxy: spec.noProxy,
    preflightNodePath: nodeExe,
    preflightCliPath: cliJs
  });

  const tmpPath = `${vbsPath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpPath, vbsContent, 'utf8');
  fsImpl.renameSync(tmpPath, vbsPath);

  const iconTarget = options.iconPath
    || installs.desktop.msix?.packageExe
    || installs.desktop.standalone
    || exePath;

  const shortcutDir = options.shortcutDir ? path.resolve(options.shortcutDir) : outDir;
  const rawName = String(options.shortcutName || 'Codex 免 TUN').replace(/[<>:"/\\|?*\r\n\0]/g, '').trim() || 'Codex 免 TUN';
  const lnkName = rawName.toLowerCase().endsWith('.lnk') ? rawName : `${rawName}.lnk`;

  const shortcuts = [];
  if (options.createShortcut !== false) {
    const primaryLnk = createShortcutLnk({
      lnkPath: path.join(shortcutDir, lnkName),
      vbsPath,
      iconTarget,
      workDir: path.dirname(exePath),
      description: `Codex 免 TUN (${redactProxyUrl(spec.proxyUrl)})`,
      _execFileSync: options._execFileSync
    });
    shortcuts.push(primaryLnk);

    if (options.alsoDesktop && options.desktopDir !== false) {
      const desktopDir = options.desktopDir || path.join(process.env.USERPROFILE || require('os').homedir(), 'Desktop');
      const desktopLnk = createShortcutLnk({
        lnkPath: path.join(desktopDir, lnkName),
        vbsPath,
        iconTarget,
        workDir: path.dirname(exePath),
        description: `Codex 免 TUN (${redactProxyUrl(spec.proxyUrl)})`,
        _execFileSync: options._execFileSync
      });
      shortcuts.push(desktopLnk);
    }
  }

  return {
    ok: true,
    exePath,
    launcherPath: vbsPath,
    shortcutPath: shortcuts[0] || null,
    shortcuts,
    proxyUrl: spec.proxyUrl,
    redactedProxyUrl: spec.redactedProxyUrl,
    noProxy: spec.noProxy,
    chromiumBypass: spec.chromiumBypass
  };
}

/**
 * Pure ASCII VBScript launcher for the clickable side-panel window (no console flash).
 */
function generateWindowsPanelVbs({ nodeExe, cliJsPath }) {
  if (!nodeExe || !cliJsPath) {
    throw new Error('缺少 Node.js 或 cli.js 路径，无法生成面板启动脚本');
  }
  const safeNode = vbsString(nodeExe);
  const safeCli = vbsString(cliJsPath);
  const msgMissing = vbsString('未找到 Node.js 或工具包脚本：');
  const msgTitle = vbsString('Codex 免 TUN 控制台');

  return [
    'Option Explicit',
    'Dim nodeExe, cliJs, fso, shell, cmd',
    `nodeExe = ${safeNode}`,
    `cliJs = ${safeCli}`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    'If Not fso.FileExists(nodeExe) Or Not fso.FileExists(cliJs) Then',
    `  MsgBox ${msgMissing} & vbCrLf & nodeExe & vbCrLf & cliJs, vbExclamation, ${msgTitle}`,
    '  WScript.Quit 1',
    'End If',
    'cmd = """" & nodeExe & """ """ & cliJs & """ panel --auto-exit"',
    'shell.Run cmd, 0, False',
    ''
  ].join('\r\n');
}

function createPanelLauncher(options = {}) {
  const fsImpl = options.fs || fs;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '..'));
  const installs = options.installations || detectCodexInstallations(options);
  const nodeExe = options.nodeExe || resolveNodeExecutable(options);
  if (!nodeExe) {
    throw new Error('未检测到 Node.js 可执行文件，无法生成面板快捷方式');
  }
  const cliJsPath = options.cliJsPath || path.join(projectRoot, 'src', 'cli.js');
  const outDir = path.resolve(options.outDir || path.join(projectRoot, 'launcher'));
  fsImpl.mkdirSync(outDir, { recursive: true });
  const vbsPath = path.join(outDir, 'launch-codex-panel.vbs');
  const vbsContent = generateWindowsPanelVbs({ nodeExe, cliJsPath });
  const tmpPath = `${vbsPath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpPath, vbsContent, 'utf8');
  fsImpl.renameSync(tmpPath, vbsPath);

  const iconTarget = options.iconPath
    || installs.desktop?.msix?.packageExe
    || installs.desktop?.standalone
    || '%SystemRoot%\\System32\\shell32.dll';

  const shortcutDir = options.shortcutDir ? path.resolve(options.shortcutDir) : outDir;
  const rawName = String(options.shortcutName || 'Codex 免 TUN 面板').replace(/[<>:"/\\|?*\r\n\0]/g, '').trim() || 'Codex 免 TUN 面板';
  const lnkName = rawName.toLowerCase().endsWith('.lnk') ? rawName : `${rawName}.lnk`;

  const shortcuts = [];
  if (options.createShortcut !== false) {
    const primaryLnk = createShortcutLnk({
      lnkPath: path.join(shortcutDir, lnkName),
      vbsPath,
      iconTarget,
      workDir: projectRoot,
      description: '打开 Codex 免 TUN 可视化侧边控制台（零注入）',
      _execFileSync: options._execFileSync
    });
    shortcuts.push(primaryLnk);

    if (options.alsoDesktop && options.desktopDir !== false) {
      const desktopDir = options.desktopDir || path.join(process.env.USERPROFILE || require('os').homedir(), 'Desktop');
      const desktopLnk = createShortcutLnk({
        lnkPath: path.join(desktopDir, lnkName),
        vbsPath,
        iconTarget,
        workDir: projectRoot,
        description: '打开 Codex 免 TUN 可视化侧边控制台（零注入）',
        _execFileSync: options._execFileSync
      });
      shortcuts.push(desktopLnk);
    }
  }

  return {
    ok: true,
    nodeExe,
    cliJsPath,
    launcherPath: vbsPath,
    shortcutPath: shortcuts[0] || null,
    shortcuts
  };
}

module.exports = {
  applyProxyVarsToEnv,
  buildDesktopLaunchSpec,
  buildCliProxyEnv,
  generateWindowsNoTunVbs,
  generateWindowsPanelVbs,
  createShortcutLnk,
  createStandaloneNoTunLauncher,
  createPanelLauncher
};
