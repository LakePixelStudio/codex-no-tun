---
name: launcher-guide
description: 指导新老用户如何一键初始化、生成桌面快捷方式、通过免 TUN 启动器冷启动 Codex Desktop 与 Codex CLI、以及如何无损恢复或卸载。
---

# 指导启停、配置或无损卸载（Codex 免 TUN）

当用户询问如何初次配置、开启、切换代理端口、停止或卸载 Codex 免 TUN 时，给出以下清晰指引：

1. **新用户一键初始化**：
   - 在工具包目录双击 `一键安装与配置.cmd`（或运行 `codex-notun-tool.cmd setup`），向导会自动探测本地代理端口、生成桌面快捷方式 `Codex 免 TUN.lnk`、让用户自选三档自动压缩上限，并可选开启 Clash 15s 保活与安装本插件。
2. **冷启动 Codex Desktop（免 TUN）**：
   - 在 Clash Verge 中保持本地 HTTP / Mixed 端口（如 `7897`）运行，关闭 TUN 模式。
   - 完全退出已有的 Codex Desktop（含系统托盘图标中的退出）。
   - 双击桌面上的 `Codex 免 TUN.lnk` 启动。
3. **启动 Codex CLI（免 TUN）**：
   - 使用 `codex-notun.cmd` 替代 `codex`（例如 `codex-notun.cmd exec "请仅回复OK"` 或 `codex-notun.cmd --https-only`）。
   - 代理环境变量仅作用于该次子进程，不修改 Windows 全局代理。
4. **打开可视化控制面板（放在 Codex 旁边纯鼠标点击）**：
   - 双击工具包中的 `控制面板.cmd` 或桌面快捷方式 `Codex 免 TUN 面板.lnk`（也可运行 `codex-notun-tool.cmd panel`），会在本地 `127.0.0.1` 打开一个 440×860 独立小窗，无需打字即可切换三档压缩上限、查看实时状态并运行断连诊断。
5. **随时调整自动压缩上限**：
   - 双击工具包中的 `调整自动压缩上限.cmd`，或在面板/对话框执行 `codex-notun-tool.cmd compact-limit <aggressive|balanced|relaxed|restore>`。
6. **停止使用与无损卸载**：
   - 仅临时不用：退出 Codex 后直接从开始菜单打开原版即可。
   - 彻底还原并卸载：双击 `一键卸载与还原.cmd`（或运行 `codex-notun-tool.cmd uninstall`），会自动还原 `config.toml`、Clash `Merge.yaml`、卸载插件并删除快捷方式。
