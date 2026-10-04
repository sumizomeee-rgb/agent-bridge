# Discord Agent Bridge

在 Windows 笔记本运行，使用已有 Discord 机器人私聊 Codex / Claude Code。文字、图片、会话绑定和原生会话 ID 都会保留；程序重启后继续当前会话。

## 使用

向原机器人私聊，直接发送文字或图片。命令也是普通私聊文字：

| 命令 | 操作 |
| --- | --- |
| `new chat` 或 `/new` | 新建当前 Agent 的会话 |
| `/new codex`、`/new claude` | 新建指定 Agent 会话 |
| `/chats` | 查看自己的历史会话 |
| `/resume 短ID` | 恢复历史会话 |
| `/agent codex`、`/agent claude` | 切换 Agent 并新建会话 |
| `/status` | 查看当前会话和排队情况 |
| `/model` | 查看 CLI 回报模型、会话选择和新会话默认 |
| `/model list` 或 `/models` | 列出当前 Agent 的模型 |
| `/model gpt-6.1-sol` | 在当前 Codex 会话切换模型，保留上下文 |
| `/model default` | 使用 CLI 当前默认模型 |
| `/model custom 模型ID` | 使用网关自定义模型 ID |
| `/stop` | 停止当前任务和待处理消息，保留上下文 |
| `/cwd 路径` | 在指定目录新建会话 |
| `/help` | 查看帮助 |

只有配置中的用户白名单可以操作；只接收私聊。回复发送最终正文，长回复按 Discord 长度限制分段；不会把逐字生成片段或工具协议发成消息。新会话会取消旧会话未完成的任务，迟到结果不会串到新会话。崩溃中正在执行的任务不自动重做，避免重复执行操作；重启后会提醒用户确认结果。

## 部署

模型选择按会话保存，重启后保留。同一 Agent 的 `/new`、`/cwd` 沿用显式模型选择；切换到另一个 Agent 时使用对应 CLI 的默认。执行或排队期间先完成任务或 `/stop`，再切模型。CLI 回报的实际模型和目录推荐默认分别显示，避免误认。自定义网关模型是否可用由下一次提供方调用验证。

已验证平台为 Windows x64。目标机器需已登录 Codex CLI，并安装 Claude Code CLI（Claude 使用自己的登录或网关设置）。两者沿用目标用户的全局配置和 skills。

1. 获取代码和编译后的 `dist/`，复制同平台 `node_modules/` 与 `.local/runtime/`。
2. 将 `config.example.json` 复制到 `.local/config.json`，填入自己的机器人 Token、用户白名单和 CLI 路径。
3. 运行 `./start.ps1 -Check` 检查配置、运行时和代理端口。
4. 运行 `./start.ps1`。在配置里设置 `proxyPort: 7898`，或启动时使用 `./start.ps1 -ProxyPort 7898`。
5. 需要登录后隐藏启动：以管理员运行 `./install-startup.ps1 -StartNow`。

`./stop.ps1` 会停止桥，并让后台监督任务停止重启。手动执行 `./start.ps1` 时重新启用运行。保持只有一处部署处理同一个机器人；程序也使用机器人身份对应的本机单实例锁。

代理端口是桥的设置，转换为 HTTP 代理地址并分别配置 Discord REST、Gateway WebSocket、图片下载和 Agent 环境变量。保留本地和工位网关的 `NO_PROXY`。不填代理端口则沿用已有环境。

## 工作目录与数据

桥代码与 Agent 默认工作目录独立。默认工作目录可以放通用 `AGENTS.md` 和环境导航 README；工位习惯作为需要时读取的参考，skills 保持在用户级目录。

`.local/`、`node_modules/`、`dist/` 不进入 Git：

- `.local/config.json`：机器人的凭据、白名单和机器路径，应限制文件 ACL。
- `.local/runtime/win-x64/node.exe`：Node 24.13.0 便携运行时。
- `.local/data/bridge.sqlite`：会话、当前绑定、消息去重和队列，含私聊数据，应备份。
- `.local/data/attachments/`：会话图片，不应在会话仍使用时删除。
- `.local/logs/`：运行状态；日志不主动保存机器人 Token。

迁移同平台时复制代码、构建和 `.local`，按新机器位置更新配置中的 CLI 和工作目录。只有目标用户本身已具有 CLI 认证才可使用，不迁移 CLI 登录 Token。

## 开发和验证

安装 Node 24，执行 `npm ci`、`npm test`、`npm run build`。测试使用临时 SQLite、模拟 Agent、模拟 Discord Gateway/HTTP；覆盖图片、原生续聊、取消、重启、重复消息和断线重连。真实机器人上线后，由用户私聊验收。

Codex 使用官方 app-server stdio；Claude 使用 CLI stream-json。最高权限沿用用户的授权配置。特殊的 Codex 交互式服务请求当前会明确报错，普通工具执行在最高权限模式下工作。
