---
name: fix-disconnect
description: 排查并缓解 Codex 的「正在重新连接」/「stream disconnected before completion: os error 10053」断连问题，并支持调整三档自动压缩上下文上限与 Clash TCP Keep-Alive。
---

# 排查 10053 断连与调整自动压缩上限（Codex 免 TUN）

当用户反馈 Codex 出现 `正在重新连接 1/5 ~ 5/5`、`stream disconnected before completion`、`os error 10053` 或想调整自动压缩阈值时，按以下流程执行：

1. **定位工具包目录**：读取 `%LOCALAPPDATA%\CodexNoTun\toolkit-root.txt`（若当前目录即工具包目录则直接使用）。
2. **运行专项诊断命令**（只读分析 `logs_2.sqlite` 传输错误计数与 Clash Mihomo 状态，不读取聊天内容或密钥）：
   - 执行 `codex-notun-tool.cmd diagnose-10053`
   - 执行 `codex-notun-tool.cmd compact-limit status`
3. **调整三档自动压缩上下文上限（自选档位）**：
   告知用户三档可选阈值（以 500k 窗口为参考，桌面版与 CLI 通用，且保留已有会话与登录态）：
   - `aggressive`（激进抗断连）：`120000` tokens（约 24%）— 最不容易触发大包 10053 断连
   - `balanced`（平衡推荐）：`180000` tokens（约 36%）— 兼顾上下文完整与连接稳定
   - `relaxed`（较宽松）：`250000` tokens（约 50%）— 保留更长原始对话记录
   - 征得用户确认后执行对应命令：
     - `codex-notun-tool.cmd compact-limit balanced`（或 `aggressive` / `relaxed` / 自定义整数 / `restore` 恢复官方默认）
   - 若用户正在使用中的单个长会话已经膨胀到 > 2 MB，也提醒在对话中发送 `/compact` 立即压缩当前会话。
4. **Clash 15s TCP 保活与防休眠**：
   - 运行 `codex-notun-tool.cmd fix-keepalive` 备份并写入 Clash Verge 的 `profiles\Merge.yaml` 与 `clash-verge.yaml` 并热重载 Mihomo（可随时用 `codex-notun-tool.cmd restore-keepalive` 还原）。
   - 或运行 `codex-notun-tool.cmd stabilize-all --compact-limit 180000` 一次性完成 Clash 保活 + 自动压缩 + `prevent_idle_sleep = true`。
   - CLI 长任务推荐使用 `codex-notun.cmd --https-only ...` 强制 HTTPS+zstd，不修改全局 `model_provider`。
5. **安全边界**：
   - 不要强行全局覆盖 `~/.codex/config.toml` 的 `model_provider`（否则会破坏桌面端已有会话归属），也不要强杀 Codex / Clash。
