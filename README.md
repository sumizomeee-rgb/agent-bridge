# Discord Agent Bridge

在 Windows 笔记本运行，使用已有 Discord 机器人私聊 Codex / Claude Code。支持双向图片，也可以要求 Agent 把生成或整理的普通文件作为附件发回。文字、图片、会话绑定和原生会话 ID 都会保留；程序重启后继续当前会话。

## 使用

向原机器人私聊，直接发送文字或图片。空闲时首条已准备好的消息等待约 1 秒，将窗口内准备好的连续消息合成一轮；每条文字和图片保持收件顺序，每个原始 Discord 消息 ID 单独持久化去重。图片下载仍按同用户顺序准备，慢图片超过窗口时可能作为后续补充处理，窗口不会为持续输入无限延长。

Codex 执行时优先通过当前 app-server 的官方 `turn/steer` 把补充送进当前轮，不必等最终回复。准备/续接期间到达的消息会在 `turn/start` 确认活动轮后尝试补入。协议已用本机 Codex CLI 0.160.0 的 `app-server generate-ts` 核验：请求使用 `threadId`、`expectedTurnId`、有序 `input`，成功响应必须返回相同 `turnId`；参见 [官方 app-server 文档](https://developers.openai.com/codex/app-server/#steer-an-active-turn)。它不改变当前轮的模型、目录或权限，也不能保证立即打断已开始的工具操作，补充的消费时机由 Codex 决定。

活动轮已结束/取消、尚未就绪、投递回复期间，或旧 CLI 明确返回“无效请求/不支持方法/无效参数”时，补充可靠排入下一轮；同一轮首次明确拒绝后不继续尝试 steer。Claude 和没有 steer 能力的后端保持排队。忙中补充提供轻量“已收到/已交给当前任务/将排队”反馈，同会话最多约 15 秒一条；不转发逐字进展。普通私聊消息收到后会添加 ⏳ 表情，表示已收到、等待处理或回复；最终回复及附件全部送达后，改为 ✅（添加完成表情，再移除沙漏）。合并消息和已确认补入当前任务的消息一起更新；中间收件提示、Agent 刚完成但回复尚未送达、失败、取消或不确定的补充不会标成完成。表情请求独立发送，失败或限流不会阻挡消息处理；先收到的沙漏请求即使延迟，也会在完成更新前结束。原生斜杠命令沿用 Discord 自带的确认收到提示。

steer 超时（10 秒）、连接断开、内部错误、响应损坏或返回不同 turn ID 时，可能已被消费，记录为 `uncertain` 并提示核对，不自动重发。完成竞态会等待已发出的 steer 确认，成功补充归入当前轮；明确未提交的消息才接下一轮。所有发送中的补充先持久化为 `steering`，重启将其与 `running` 一起标记中断，不重做已经执行过的工具。执行 `completed` 和回复 `reply_state`（待投递/成功/失败/取消）独立保存，回复或附件投递失败不重跑 Agent；重启发现已完成但待投递的回复会提醒核对，也不重跑。

`/stop`、`/new`、`/agent`、`/cwd` 和新会话文字别名会越过慢图片准备及时处理，旧准备中的普通消息会持久化取消，旧轮迟到结果不能发送到新绑定。控制命令只使用文字选项，随命令附带的图片不进入 Agent；无效或重复控制命令也可能结束当前收件准备窗口，请单独发送普通图片消息。已开始的工具操作无法回滚。

输入 `/` 可以选择 Discord 原生菜单，也保留以下普通私聊文本命令：

| 命令 | 操作 |
| --- | --- |
| `new chat` 或 `/new` | 新建当前 Agent 的会话 |
| `/new codex`、`/new claude` | 新建指定 Agent 会话 |
| `/chats` | 只读查看自己的历史会话 |
| `/agent codex`、`/agent claude` | 切换 Agent，优先续接当前目录下的上次会话；没有则新建 |
| `/agent` | 查看当前 Agent 和两种切换指令 |
| `/status` | 查看当前会话和排队情况 |
| `/model` | 查看 CLI 回报模型、会话选择和新会话默认 |
| `/model list` 或 `/models` | 列出当前 Agent 的模型 |
| `/model gpt-6.1-sol` | 在当前 Codex 会话切换模型，保留上下文 |
| `/model default` | 使用 CLI 当前默认模型 |
| `/model custom 模型ID` | 使用网关自定义模型 ID |
| `/stop` | 停止当前任务和待处理消息，保留上下文 |
| `/cwd 路径` | 在指定目录新建会话 |
| `/help` | 查看帮助 |

原生菜单的 `/agent` 使用 `agent` 选项；`/model` 使用 `name` 选项，例如选择 `/model` 后填 `name: gpt-6.1-sol`，或在 Claude 会话填 `name: haiku`、`sonnet`、`opus`。留空查询当前模型，填写 `list` 或 `default` 分别列出模型或恢复 CLI 默认；网关自定义 ID 可同时启用 `custom`。模型名称原样传给 CLI，别名映射完全沿用用户配置。

启动后自动同步 9 个仅限机器人私聊的原生命令，替换此应用旧菜单，不注册 `/resume`。命令先由 Discord 确认收到，再执行并回复同一交互；普通聊天和模型最终回复仍是私聊消息。注册失败会记录日志，不阻断普通私聊。菜单尚未刷新时可关闭再打开私聊，或直接发送上表文本命令。

图片和普通文件回传无需额外命令，直接说“截图发我”或“把文件发我”即可。工作目录的 `AGENTS.md` 约定：图片用 `![说明](<本地图片绝对路径>)` 声明，普通文件用 `[文件名](<本地文件绝对路径>)` 声明；`CLAUDE.md` 通过 `@AGENTS.md` 共用它。桥原样提交用户消息和图片，不额外追加上下文或创建每轮产物目录，只解析最终回复中明确声明的文件并上传 Discord 附件。当前工作目录及之前的 `.local/data/outgoing` 是允许的文件范围；工位上的文件需先通过 SSH 下载到笔记本当前工作目录，再声明本地绝对路径。普通文件必须使用带尖括号的显式声明；不带尖括号的路径链接及含 `:行号`、`:行号:列号`、`#L`、`#line` 定位后缀的源码引用保留原文。网页链接保留原文，代码示例不会触发上传。普通文件目前支持 Agent 发给用户；用户发给 Agent 的附件仍支持图片。

图片支持 PNG、JPG、WebP、GIF，每张最多 10 MiB（`maxImageBytes` 配置更小时沿用配置），以实际图片格式确定附件类型和扩展名，原文件及图片字节不变。普通文件的 `maxFileBytes` 默认是 `20971520`（20 MiB），可配置为正整数字节数，上限 `25165824`（24 MiB）。每轮图片与普通文件合计最多 10 个、100 MiB，发送时每批附件最多 24 MiB。

这些是项目限额，实际上传还受 Discord 限制：[官方文件上传文档](https://docs.discord.com/developers/reference#uploading-files)目前列出单文件默认 20 MiB，可按目标上下文提高；[发送消息接口](https://docs.discord.com/developers/resources/message#create-message)的单请求上限是 25 MiB，包含正文和 multipart 开销。调大 `maxFileBytes` 不会提高 Discord 的实际额度，每轮 100 MiB 也不等于单请求可发 100 MiB。文件不存在、越界、图片格式无效、超过限额或 Discord 拒绝上传时会明确报错，保留原会话，不重跑模型、截图或其他工具。

只有配置中的用户白名单可以操作；只接收私聊。每轮发送最终回复，程序在正文前添加紧凑回复头，例如 `[Codex · 6.1-sol · 中 · b2c3]`。回复头省略模型的 `gpt-` 前缀，推理强度使用中文短标签，会话 ID 仅显示末 4 位；完整模型 ID 和会话 ID 保持原样。模型和推理强度取本轮 CLI 回报，未确认时显示“模型未知”或“强度未知”，不会猜测或覆盖 CLI 默认配置；Claude 的强度目前未确认。会话尾号来自真实原生会话 ID；`/chats` 显示的桥会话短 ID 仅供查看，是另一种标识。

长回复按 Discord 长度限制分段，每段带同一个回复头；不会把逐字生成片段或工具协议发成消息。新会话会取消旧会话未完成的任务，迟到结果不会串到新会话。崩溃中正在执行的任务不自动重做，避免重复执行操作；重启后会提醒用户确认结果。

## 后台 Agent 任务

本轮结束后仍需继续执行的本机或 SSH 子 Agent，由父 Agent 自己派发，并先登记任务、设置完成监听。桥不负责 SSH 派发，也不把普通任务自动拆成子 Agent；没有登记的后台进程不会计数或主动汇报。使用规则放在工作目录的 `AGENTS.md`。

桥启动父 CLI 时，仅通过 `BRIDGE_TASK_CONTEXT` 环境变量提供本轮的登记凭据文件。该文件包含 `nodePath`、`helperPath`；Agent 可用它们调用任务工具，不需要输入父会话 ID：

```powershell
$ctx = Get-Content -LiteralPath $env:BRIDGE_TASK_CONTEXT -Raw | ConvertFrom-Json
$job = & $ctx.nodePath $ctx.helperPath register --title '工位检查' `
  --exit-file 'E:\任务目录\exit.txt' --result-file 'E:\任务目录\result.txt' `
  --ssh-config 'C:\SuchProject\Other\ssh-project\hosts\11032022110008\ssh_config' --ssh-host administrator |
  ConvertFrom-Json
```

`register` 必须在父 Agent 本轮结束前执行。可在登记时直接附上监听参数，或之后用 `watch --task-id $job.taskId` 设置同样的参数。普通任务完成时先写 UTF-8 结果，再原子写入退出码文件；退出码 0 表示成功，非 0 会汇报失败。SSH 监听中的结果路径指向目标电脑，SSH 配置路径指向笔记本。

取消旧后台任务时，先使用对应 runner 停止并核实外部进程，再调用 `cancel --task-id <任务 ID> --text '取消原因及进程核查结果'`。`cancel` 使用当前 `BRIDGE_TASK_CONTEXT`，允许同一用户、同一会话跨轮取消旧任务，直接持久化取消状态并清除计数；不会停止外部进程。重复取消不会重复通知，已完成的任务不会改成取消。`watch` 和 `status` 仍需原注册轮次的上下文；不要用下一轮的上下文改旧任务监听。`complete` 仅生成签名回执文件，只有已登记监听读取该文件后才会更新状态，不能将“回执已生成”当作“取消已入库”。

也可使用签名回执：登记时指定 `--completion-file`，把登记返回的 `ticketPath` 复制到执行任务的电脑，再用仓库的 `scripts/task-complete.ps1 -TicketPath <票据路径> -OutputPath <完成文件路径> -Status completed -ResultFile <结果文件路径>` 生成回执；失败用 `failed`。有 Node 运行时的目标机也可调用 `task-cli.js complete --ticket ... --output ... --status completed --result-file ...`。每份票据只对应一个任务，不能用于登记新任务；上下文和票据是私有运行数据，不要发进 Discord 或提交 Git。

任务终态持久化后，桥会在父 Agent 空闲时续接原来的完整原生会话，让父 Agent 核对工具结果并主动回复同一私聊。普通用户消息优先；完成事件不会伪装成人类消息或新增用户授权。重复回执只汇总一次。`/new`、`/cwd`、切换 Agent 或 `/stop` 会取消旧任务的自动续接，远端任务可以继续运行，完成后只发送带来源的结果通知。正在生成或投递汇总时崩溃，重启会提醒核对，不自动重跑。

当前会话最新一条普通消息上的 `1️⃣`–`9️⃣`、`🔟` 表示仍在执行的已登记任务数量；超过 10 个显示 `🔟➕`，`/status` 显示准确数量。新普通消息到来时转移计数，任务完成时减少，归零后移除。原来的 ⏳ 收件及 ✅ 回复送达标记继续保留；父 Agent 首次回复完成后，后台任务数字仍会更新。

## 部署

`/agent` 选择当前 Agent 保持原会话；来回切换会自动恢复当前用户在当前目录下最近一次该 Agent 的上下文，无需输入会话 ID，切换时取消原会话待处理任务。命令提示会明确显示恢复或新建，以及已知的原生会话尾号。`/new` 始终新建会话。旧 `/resume` 命令已停用，发送也不会切换绑定或启动 Agent；`/chats` 仅查看历史。

模型选择按会话保存，重启后保留。同一 Agent 的 `/new`、`/cwd` 沿用显式模型选择；首次新建另一个 Agent 的会话时使用对应 CLI 默认，恢复历史会话则保留历史选择。执行或排队期间先完成任务或 `/stop`，再切模型。CLI 回报的实际模型和目录推荐默认分别显示，避免误认。自定义网关模型是否可用由下一次提供方调用验证。

Codex 每轮读取当前工作目录的生效配置，按当前供应商直接使用原生 ID 续接，并核对返回供应商及会话 ID。续接时使用 `excludeTurns: true` 省略返回的历史正文，Codex 仍恢复完整上下文，避免图片和工具历史累积导致桥的单条输出超限。CC Switch 切换后无需手动恢复命令。若无法确认安全续接，保留旧会话并明确报错，本轮任务尚未提交；不会自动另开空会话或重做工具操作。供应商与认证仍由用户的 CLI / CC Switch 配置管理。

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
- `.local/data/bridge.sqlite`：会话、当前绑定、消息去重、队列和上一条成功回复标识，含私聊数据，应备份。
- `.local/data/tasks.sqlite`：后台任务及完成事件；与会话数据库一起备份。
- `.local/data/contexts/`、`.local/data/tickets/`：父轮次登记凭据和单任务回执票据，只供桥及授权子任务使用。
- `.local/data/attachments/`：会话图片，不应在会话仍使用时删除。
- `.local/data/outgoing/`：之前回传的图片及普通文件，继续支持明确引用；不自动扫描、上传或为新消息创建目录。
- `.local/logs/`：运行状态；日志不主动保存机器人 Token。

迁移同平台时复制代码、构建和 `.local`，按新机器位置更新配置中的 CLI 和工作目录。只有目标用户本身已具有 CLI 认证才可使用，不迁移 CLI 登录 Token。

## 开发和验证

安装 Node 24，执行 `npm ci`、`npm test`、`npm run build`。测试使用临时 SQLite、模拟 Agent、模拟 Discord Gateway/HTTP；覆盖图片与普通文件回传、原生续聊、取消、重启、重复消息和断线重连。真实机器人上线后，由用户私聊验收。连续消息测试另外覆盖合并窗口、原始 ID 去重、有序图片输入、steer 协议、完成竞态、取消/切换、后端降级和重启/投递失败不重放。受限环境如果测试 runner 无法启动子进程，可用 `node --test --test-isolation=none dist/test/*.test.js` 运行全套；涉及 CLI 子进程的集成测试仍需允许子进程启动的环境。

升级时应在任务结束后由部署方安排重启，提前备份数据库；新版本启动会给 inbox 增加 `reply_state` 列，旧去重记录、原生会话 ID 和绑定保留。仅编译 `dist` 不会让已经运行的桥加载新逻辑，开发验证不要同时启动第二个机器人 worker。

Codex 使用官方 app-server stdio；Claude 使用 CLI stream-json。最高权限沿用用户的授权配置。特殊的 Codex 交互式服务请求当前会明确报错，普通工具执行在最高权限模式下工作。
