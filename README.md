# Codex 免 TUN（Windows 工具包）

面向 Windows 原生 **Codex Desktop**（Windows Store / MSIX 与独立安装版）及 **Codex CLI** 的免 TUN 本地代理启动器、CLI 包装命令、防 `os error 10053` 断连优化、三档自选自动压缩上限与官方格式 Codex 插件。

- **零改盘、零注入**：不修改 `app.asar`、不做 TLS 解密、不修改模型 API 地址、不改动 Windows 系统全局代理。
- **保留全部现有数据**：完整保留您现有的 ChatGPT 登录态、订阅、项目与历史会话。
- **双端统一**：桌面版双击快捷方式冷启动，CLI 直接使用 `codex-notun.cmd`，均仅作用于当次启动的进程树。
- **开箱防断连**：内置 `os error 10053` 诊断、Clash Verge 15s TCP 保活（可还原）、防休眠开关与 **3 档自选上下文自动压缩阈值**。
- **Codex 内可用**：附带原生插件 **Codex 免 TUN**（支持 `@Codex 免 TUN` 调用与面板展示）。

---

## 一、新用户 1 分钟快速开始

### 前置条件
- Windows 10 / 11
- 已安装 **Node.js 18+**
- 本地代理客户端（如 **Clash Verge / Mihomo**）正在运行且开启了本地 HTTP / Mixed 端口（例如 `127.0.0.1:7897`），**TUN 模式保持关闭**。

### 方式一：双击一键向导（推荐）
1. 下载本仓库（或 Release ZIP 解压到任意不含临时清理的路径）。
2. 双击运行 **[`一键安装与配置.cmd`](一键安装与配置.cmd)**，按中文向导选择：
   - 自动探测并确认本地 Clash HTTP / Mixed 端口（如 `127.0.0.1:7897`）
   - 自动在桌面生成快捷方式 **`Codex 免 TUN.lnk`**
   - **三档自选自动压缩上下文上限**（推荐 `180,000` / 激进 `120,000` / 较宽松 `250,000`）
   - 是否为 Clash Verge 写入 15s TCP 保活并开启 Codex 防休眠
   - 是否安装官方格式 Codex 插件（安装后可在 Codex 界面里 `@Codex 免 TUN` 使用）
3. 完全退出原版 Codex Desktop（含系统托盘退出），双击桌面的 **`Codex 免 TUN.lnk`** 启动即可。

### 方式二：交给 AI 助手一句话配置
如果您已经在某个 AI 编程工具中打开了本仓库，直接对它说：
> **「请阅读 `AGENTS.md`，帮我完成 Codex 免 TUN 初始化配置并验证通过。」**

---

## 二、三档自选自动压缩上下文（防 `os error 10053` 断连）

Codex 默认会在对话接近上下文窗口 **90%** 时才自动压缩（例如 50 万窗口模型到约 45 万 token）。在 Windows + 代理环境下，超长对话单轮请求可膨胀到数 MB，经过默认的 `responses_websocket`（`wss://`）长连接传输时很容易被本机/中间网关中止并出现：
`正在重新连接 1/5 ... stream disconnected before completion: IO error: 你的主机中的软件中止了一个已建立的连接。 (os error 10053)`

本工具提供可随时切换、且可无损还原的三档预设（写入 `~/.codex/config.toml` 根级 `model_auto_compact_token_limit`，桌面版与 CLI 通用，不影响已有会话）：

| 档位 | 参数名 | 上限 (Tokens) | 占 500k 窗口比例 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **激进抗断连** | `aggressive` / `120k` | `120,000` | 约 24% | 最不容易触发大包 10053 断连，适合长代码重构与多工具任务 |
| **平衡推荐** | `balanced` / `180k` | `180,000` | 约 36% | 兼顾上下文保留长度与连接稳定性（新用户默认推荐） |
| **较宽松** | `relaxed` / `250k` | `250,000` | 约 50% | 需要保留更长原始对话时使用（含大图/长日志时留意体积） |

### 随时调整或还原
- **双击调整**：运行 **[`调整自动压缩上限.cmd`](调整自动压缩上限.cmd)**，按数字键 `1/2/3/4/5` 实时切换或恢复官方默认。
- **命令行调整**：
  ```cmd
  codex-notun-tool.cmd compact-limit status
  codex-notun-tool.cmd compact-limit balanced
  codex-notun-tool.cmd compact-limit aggressive
  codex-notun-tool.cmd compact-limit relaxed
  codex-notun-tool.cmd compact-limit 150000
  codex-notun-tool.cmd compact-limit restore
  ```
- **在 Codex 对话内调整**：直接 `@Codex 免 TUN` 让它帮您查看或切换档位。

---

## 三、日常使用入口

### 1. Codex Desktop（桌面版）
- 双击桌面快捷方式 **`Codex 免 TUN.lnk`**（每次启动前会先检查代理端口是否存活、是否有旧实例未退出；代理不可用时立即报中文错误并中止，**绝不静默改为直连**）。
- 如需更换代理端口或重新生成快捷方式，双击 **[`配置与生成快捷方式.cmd`](配置与生成快捷方式.cmd)**。

### 2. Codex CLI
```cmd
:: 使用已保存/探测到的代理启动 Codex CLI
codex-notun.cmd

:: 长任务抗 10053 断连模式（进程级强制 HTTPS+zstd，禁用 WebSocket，保留 ChatGPT 登录态）
codex-notun.cmd --https-only -- exec "请仅回复OK"

:: 显式指定代理地址
codex-notun.cmd --proxy http://127.0.0.1:7897 -- exec "请仅回复OK"

:: 切换 npm 安装版 CLI 或 MSIX 内置版 CLI
codex-notun.cmd --use-npm-cli -- --version
codex-notun.cmd --use-bundled-cli -- --version
```

### 3. 诊断与一键防断连优化
- 双击 **[`诊断检查.cmd`](诊断检查.cmd)**：检查桌面版/CLI 安装路径、WinINet 状态、TUN 网卡状态、`respect_system_proxy` 冲突与代理健康度（支持离线运行）。
- 双击 **[`排查10053断连.cmd`](排查10053断连.cmd)**：只读扫描 `logs_2.sqlite` 传输断开次数、最大请求体积与 Clash TCP 保活参数。
- 一键命令行命令：
  ```cmd
  codex-notun-tool.cmd check
  codex-notun-tool.cmd diagnose-10053
  codex-notun-tool.cmd clash-evidence
  codex-notun-tool.cmd stabilize-all --compact-limit 180000
  codex-notun-tool.cmd fix-keepalive
  codex-notun-tool.cmd restore-keepalive
  ```

---

## 四、Codex 插件（界面内直接查看与使用）

安装工具包内置插件后，可在 Codex Desktop 的 **Plugins** 面板看到 **Codex 免 TUN**，或在输入框直接 `@Codex 免 TUN`：
- **检查代理**（`check-proxy`）：离线/在线检测 Clash 端口、TUN 状态与 `respect_system_proxy` 冲突。
- **查看状态**（`proxy-status`）：查看桌面版/CLI 版本、脱敏 Clash 连接链（`HTTPS`/`HTTP` vs `Tun`）与自动压缩上限。
- **排查 10053 断连**（`fix-disconnect`）：诊断重连根因并指导或执行三档压缩上限切换与保活优化。
- **启停与恢复指引**（`launcher-guide`）：指导快捷方式冷启动、CLI 用法与无损卸载。

手动安装/卸载命令：
```cmd
codex-notun-tool.cmd plugin install
codex-notun-tool.cmd plugin uninstall
```
*(若刚安装或升级插件，重启一次 Codex Desktop 即可在界面看到最新图标与提示词。)*

---

## 五、技术原理与安全边界

1. **进程级代理注入**：
   - 生成纯 ASCII `.vbs` 启动脚本（通过 `ChrW()` 转义中文及空格路径，避免 Windows GBK/UTF-8 编码问题），仅向子进程注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（强制包含 `localhost,127.0.0.1,::1`）、`NODE_USE_ENV_PROXY=1`，并为桌面端附加 `--proxy-server` 与 `--proxy-bypass-list`。
   - 对 Windows Store / MSIX 版自动通过稳定的 `%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe` AppExecutionAlias 启动，跨版本升级不断链。
2. **`respect_system_proxy` 注意事项**：
   - Codex 默认 `respect_system_proxy = false` 时严格遵守进程级环境变量；若用户手动将其设为 `true` 且 Windows 系统代理处于关闭状态，Codex 会忽略环境变量中的代理并直连。诊断工具会自动检测并提示。
3. **协议支持范围**：
   - 首版支持 Clash 本地 **HTTP / Mixed** 端口（`http://` / `https://`）。实测 `socks5://` 下部分内部子客户端仍会发出明文 HTTP `CONNECT`，故首版未将纯 SOCKS5 列为支持。
4. **隐私与可逆保证**：
   - 绝不读取或输出 `auth.json`、`~/.codex/.env` 的值、Clash `secret`、代理密码或聊天文本。
   - 所有对 `config.toml` 或 Clash `Merge.yaml` 的修改均仅合并指定键、自动生成时间戳备份，并保留用户后续所做的其他修改。

---

## 六、无损卸载与恢复

双击 **[`一键卸载与还原.cmd`](一键卸载与还原.cmd)** 或运行：
```cmd
codex-notun-tool.cmd uninstall
```
工具会自动还原其写入的 `config.toml` 单键、`Merge.yaml` 保活键、卸载 `codex-no-tun` 插件并删除快捷方式；随后删掉本目录与 `%LOCALAPPDATA%\CodexNoTun` 即可完全清除。

---

## 七、测试与打包发布

```cmd
:: 运行全部单元测试与隔离集成测试
npm test

:: 打包纯净的 GitHub Release ZIP（自动过滤本机临时文件与路径并做隐私扫描）
npm run pack:release
```

---

## 八、致谢与开源协议

本项目的代理发现、URL 校验、进程级环境构造、纯 ASCII VBScript 无黑窗启动器及分层健康检查思路参考并复用了：
- **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)**（Commit `c057717d1fc2cbe15ae0ce59287877d054eed4c2`, MIT License）

完整许可声明见 [`LICENSE`](LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
