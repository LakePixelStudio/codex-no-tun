# AGENTS.md — AI 智能体一键安装与验证指南

如果你将本仓库交给 AI 编程助手帮你安装配置，只需对它说：
**「请阅读仓库里的 AGENTS.md，帮我完成 Codex 免 TUN 初始化配置并验证通过。」**

## 执行步骤（零外部依赖，仅需 Node.js 18+）

1. **只读环境与代理探测**：
   ```cmd
   codex-notun-tool.cmd check
   ```
   - 确认本地 Clash / Mihomo HTTP 或 Mixed 端口（如 `127.0.0.1:7897`）处于监听状态。
   - 若用户本机存在 `respect_system_proxy = true` 且 Windows 系统代理关闭，提醒该冲突；默认不要覆盖全局 `model_provider`。

2. **询问或按用户偏好执行初始化**：
   - 自动压缩上下文有三档可选：
     - `balanced`（`180000` tokens，推荐）
     - `aggressive`（`120000` tokens，最抗 10053 断连）
     - `relaxed`（`250000` tokens）
   - 确定用户的代理端口和自动压缩档位后，执行非交互初始化：
     ```cmd
     codex-notun-tool.cmd setup --proxy http://127.0.0.1:7897 --compact balanced --keepalive --prevent-sleep --install-plugin
     ```
   - （若用户不想写入 Clash 保活或不想装插件，去掉对应开关即可。）

3. **安全与隐私红线**：
   - 严禁读取或回显 `~/.codex/auth.json`、`~/.codex/.env` 值、Clash `secret` 或代理密码。
   - 严禁强杀用户正在运行且未保存对话的 `ChatGPT.exe` / `codex.exe` 或 Clash 进程；提示用户完全退出 Codex 后双击桌面 `Codex 免 TUN.lnk` 启动。
   - 严禁修改 `app.asar`、注入客户端、做 TLS 解密或更改模型 API `base_url`。

4. **验证验收**：
   - 运行 `node --test test/*.test.js` 确认测试全绿。
   - 若用户关闭了 Clash TUN 并重启了 Codex Desktop，可用 `codex-notun-tool.cmd clash-evidence` 验证连接类型为 `HTTPS`/`HTTP`（非 `Tun`）。
