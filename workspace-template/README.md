# sumizome 笔记本助手导航

当前机器：DESKTOP-6FVMGQD，Windows，用户 sumizome。这里用于普通聊天、查看笔记本环境和安排工作。

- 网络项目：`C:\SuchProject\Other\ssh-tunnel-proxy`。代理是 `http://127.0.0.1:7898`，通过已连接的飞连使用工位网络。
- SSH 配置库：`C:\SuchProject\Other\ssh-project`。
- 工位电脑：主机 `11032022110008`，配置文件 `C:\SuchProject\Other\ssh-project\hosts\11032022110008\ssh_config`，别名 `administrator`。
- 核对工位：`ssh.exe -F "C:\SuchProject\Other\ssh-project\hosts\11032022110008\ssh_config" administrator hostname`。
- 工位默认 PowerShell 建议调用 `pwsh.exe`；中文脚本和复杂引号使用 UTF-16LE EncodedCommand 或传文件运行。
- 工位工作习惯参考：`workstation-habits.md`（来自用户自己的 MyHaruSkills README，仅在相关工作时读取）。
- 桥程序：`C:\SuchProject\Other\discord-agent-bridge`，会话和图片在该项目 `.local/data`。
- Codex / Claude 的登录、提供商、skills 都使用各自用户级目录。切换提供商通过 CC Switch 完成。

- 家里本机：`DESKTOP-HB47FVQ`，Windows，用户 `sumizome`；当前局域网 IP 为 `192.168.0.105`，连接配置使用主机名，避免 DHCP 地址变化。
- 家里配置：`C:\SuchProject\Other\ssh-project\hosts\DESKTOP-HB47FVQ-家里本机\ssh_config`，别名 `sumizome`。
- 核对家里：`ssh.exe -F "C:\SuchProject\Other\ssh-project\hosts\DESKTOP-HB47FVQ-家里本机\ssh_config" sumizome hostname`，应返回 `DESKTOP-HB47FVQ`（2026-10-05 已验证）。
- 共用技能：`C:\Users\sumizome\.agents\skills` 通过 Junction 指向现有 `.claude\skills`（MyAgentSkills），Codex 已扫描启用 28 个仓库技能。
