---
name: proxy-status
description: 查看当前 Codex 免 TUN 运行状态、已安装的 Codex Desktop (MSIX/独立版) 与 CLI 版本、TUN 网卡状态、自动压缩上限与脱敏 Clash 连接记录。
---

# 查看状态（Codex 免 TUN）

当用户要求查看免 TUN 状态、确认流量是否经过 Clash、或查看当前自动压缩上限时，按以下步骤执行：

1. **定位工具包根目录**：读取 `%LOCALAPPDATA%\CodexNoTun\toolkit-root.txt`（或当前目录即为工具包目录）。
2. **查看环境与进程状态**：
   - 运行 `codex-notun-tool.cmd status` 查看 Codex Desktop/CLI 版本、`TUN 虚拟网卡` 状态、运行中进程及抗断连摘要。
   - 运行 `codex-notun-tool.cmd compact-limit status` 查看当前 `model_auto_compact_token_limit` 档位。
3. **查看脱敏后的 Clash 连接证据**（若 Clash Verge / Mihomo 命名管道 `\\.\pipe\verge-mihomo` 可访问）：
   - 运行 `codex-notun-tool.cmd clash-evidence`。
   - 仅展示脱敏字段（`host`、`port`、`rule`、`chains`、`process`），确保连接类型为 `HTTPS`/`HTTP` 而非 `Tun`，绝不读取或输出任何账号令牌或代理凭据。
4. **查看断连风险统计**（如用户遇到重连/10053）：
   - 运行 `codex-notun-tool.cmd diagnose-10053` 检查最近 `10053` 次数、最大请求体积和 Clash `keep-alive-idle`。
