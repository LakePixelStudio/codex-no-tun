---
name: check-proxy
description: 检查本地 Clash / Mihomo HTTP / Mixed 代理端口、Codex Desktop/CLI 代理配置兼容性，以及连通性健康状态（可离线运行，不泄露凭据）。
---

# 检查代理（Codex 免 TUN）

当用户要求检查本地代理、排查免 TUN 无法联网或连接超时问题时，按以下步骤执行：

1. **定位本机工具包目录**（不依赖固定盘符）：
   - 优先读取 `%LOCALAPPDATA%\CodexNoTun\toolkit-root.txt` 中的工具包根目录路径（若当前工作区就是工具包目录则直接使用当前目录）。
   - 在工具包根目录运行：
     - `codex-notun-tool.cmd check`（或 `node src/cli.js check`）
     - 若需测试隧道连通性：`codex-notun-tool.cmd check --probe http://www.gstatic.com/generate_204`
     - 若需排查 `os error 10053` 断连：`codex-notun-tool.cmd diagnose-10053`
2. **核对输出中的关键字段**：
   - `configValid`：代理 URL 是否符合 `http://` / `https://` 与端口规范（首版仅支持 HTTP / Mixed 端口）。
   - `proxyReachable`：本地端口（如 `127.0.0.1:7897`）是否处于监听状态；不可达时会报错中止，不会静默改为直连。
   - `respect_system_proxy`：若 `~/.codex/config.toml` 中设为 `true` 且 Windows 系统代理关闭，Codex 会忽略环境变量中的 `HTTP_PROXY`/`HTTPS_PROXY` 而直接直连——需向用户明确指出。
   - `modelCallVerified`：仅代表端口与基础连通性；真实模型对话流式回复需通过实际消息验收。
3. **安全红线**：
   - 严禁读取或回显 `auth.json`、`~/.codex/.env` 的值、Clash `secret` 或代理账号密码。
   - 严禁强杀 Codex 或 Clash 进程。
