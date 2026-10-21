# Profile、Bot 与宿主迁移

桥项目名称为 `agent-bridge`。正式入口读取 `version: 3` 配置，一个宿主启动同一聊天平台的多个 Bot；各 Bot 独立维护账号绑定、当前主控和运行数据；用户上下文工作区由配置决定，可以共用，宿主协调工作群、公开进展和跨 Bot 交接。

## 身份与启动集合

Profile 是本地预设名，例如 `feishu/bot1`、`feishu/bot2`。稳定身份使用真实应用 ID：`feishu:<applicationId>` 或 `discord:<applicationId>`；内部用户、频道和消息再以 `botId + "|"` 为命名空间。Bot 显示名和 Profile 名可以调整；不能把另一个应用的 ID 写进旧 Profile 来冒充原 Bot。每个 Bot 的现有私有 Profile 可以用 `aliases` 登记称呼，例如 `"aliases": ["Miku"]`；省略为空数组，不另建身份 Markdown。别名最多 32 项，每项 1–64 个字符，禁止空值、控制字符、规范化重复和不同 Bot 的歧义；不改变真实 ID、白名单、目录、职责或权限。桥将本人及参与成员的别名作为运行事实提供给主控，普通称呼由模型理解，不作为真实 @ 实体或强制派工条件。

公共配置的 `startupProfiles` 是完整启动集合，所有成员必须属于同一平台，不允许重复应用身份。`-Profile` 只检查它是否属于这个集合，`-Platform` 只检查平台一致，均不会单独启动一个成员或遗留其他成员。更换集合应先正常停止宿主，再修改公共配置并重新启动。

```powershell
.\start.ps1                         # 启动完整 startupProfiles 集合
.\start.ps1 -Check                  # 离线配置与本机路径检查
.\start.ps1 -Profile feishu/bot1 -Check
.\install-startup.ps1 -StartNow      # 安装一个宿主监督任务
```

`start-feishu.bat`、`start-discord.bat` 同样受集合与平台检查约束。项目锁阻止同一项目重复运行，每个 Bot 还有真实应用身份锁；成员鉴权或启动失败会记录为离线，不阻止其他健康成员的私聊。群操作涉及离线成员时会明确报告，不能把不完整执行说成整组成功。宿主共用监督进程和安全重启，不为每个 Bot 另开监督任务。聊天命令不切换平台、Profile 或启动功能。

## 本地配置与目录

```text
config.example.json                        # Git：version:3 公共模板
profiles/feishu.example.json                # Git：飞书 Bot 模板
profiles/discord.example.json               # Git：Discord Bot 模板
.local/config.json                         # 私有：CLI、startupProfiles、principals、spaces
.local/bots/feishu/bot1.json                 # 私有：应用身份、凭据、白名单、功能、网络
.local/bots/feishu/bot2.json
.local/workspaces/feishu/<applicationId>/    # 默认独立上下文工作区
.local/data/host.sqlite                     # 宿主账号、群、事件和交接登记
.local/data/host-inbox.sqlite                # 群收件与独立恢复游标
.local/data/restart.sqlite                  # 宿主重启阶段
.local/data/bots/feishu/<applicationId>/     # 该 Bot 的会话、任务、附件、原生主控 home
.local/logs/feishu/<applicationId>/          # 该 Bot 日志
.local/backups/                             # 私有迁移备份
```

公共配置使用 `workspaceRoot` 指定默认上下文根目录、`workingCwd` 指定默认工程执行目录；Profile 可用 `workspace`、`workingCwd` 分别覆盖。初始化、长期记忆、远程电脑和能力登记始终从该 Bot 固定的上下文工作区读取，执行任务在所选工程目录工作。`/cwd` 改工程目录并新建主控，不会把其他工程目录当成新的长期记忆入口。多个 Bot 可以把 `workspace` 配置为同一个用户目录，共用 README、MEMORY、平台指南和能力／预设登记；会话、任务、认证副本、附件与日志仍按 Bot ID 隔离。共享目录由用户明确配置，不复制用户记忆或按 Bot 自动分叉。

Profile 还可设置 `defaultAgent: "codex"` 或 `defaultAgent: "claude"`；未设置时继承公共 `defaultAgent`，公共配置也未设置时使用 Codex。例如 Bot1 保持 Codex、Bot2 初始使用 Claude，只需在 Bot2 的 Profile 写入 `"defaultAgent": "claude"`。这个默认值只用于尚无当前主控的初始化，不会切换已有会话、清除原生上下文或覆盖该 Bot 已保存的模型与推理力度偏好；模型默认仍使用公共 `defaultModels`。

凭据、白名单、实际路径、聊天、任务、认证副本和备份均不提交 Git。模板、校验、启动代码和说明提交 Git。新增 Bot 时复制相应模板，填入真实应用身份、凭据与白名单，指定共用或独立的用户工作区，再把 Profile 加进启动集合。飞书白名单使用该应用下的用户 Open ID，不同应用的 Open ID 不能互换。

## 操作者与群地址登记

一个 Bot 只服务一个激活的聊天平台账号，该账号的私聊和多个工作群共用本 Bot 的当前主控。`principals` 显式登记“同一个操作者在不同应用中的账号”；Profile 的可选 `ownerPrincipalId` 预先绑定操作者。未绑定 Bot 只能在已登记、白名单账号的明确初始化或普通私聊输入后认领，不能靠查看状态抢占，也不根据昵称、姓名或最近活跃时间猜测本人。

下面仅展示字段结构，ID 均须替换为已核实的事实：

```json
{
  "version": 3,
  "startupProfiles": ["feishu/bot1", "feishu/bot2"],
  "workspaceRoot": ".local/workspaces",
  "groupMode": true,
  "internalBotCommunicationEnabled": false,
  "principals": [{
    "id": "me",
    "accounts": {
      "feishu:cli_APP1": "ou_OWNER_IN_APP1",
      "feishu:cli_APP2": "ou_OWNER_IN_APP2"
    }
  }],
  "spaces": [{
    "id": "work-group",
    "accounts": {
      "feishu:cli_APP1": "oc_CHAT_IN_APP1",
      "feishu:cli_APP2": "oc_CHAT_IN_APP2"
    }
  }]
}
```

此片段须合并进包含 CLI 等公共设置的完整配置。飞书同一实际群在各应用下的地址必须逐一核对并登记；即使目前读到相同 chat ID，也不能把显示名相同或 ID 恰好相同当成跨应用映射证明。Discord 的工作空间按频道或话题划分，不能把整个服务器当成一个工作群。

`groupMode` 只有显式 `true` 才接收群输入，还需机器人和负责人在群、权限可验证、成员账号属于同一操作者等检查。机器人、Webhook、未知账号和未授权真人消息不启动执行。提及使用平台实体 ID 解析，正文中的 Bot 昵称不算点名。群启用及命令见[使用说明](usage.md#工作群与当前主控)。

## 网络与可选功能

公共配置的 `internalBotCommunicationEnabled` 是独立布尔开关，与群内 `bridge_silent` 无关。省略时为 `true`，保持既有部署；`config.example.json` 显式为 `false`，新部署先使用群公开协作。它在宿主启动时加载，修改后需安全重启桥，不支持聊天命令修改，也不要求 `/new`。

设置 `false` 时，关闭跨 Bot 的 `bridge_send_bot`、`bridge_start_collaboration` 的 `internal` 模式及当前依赖内部通知的 `bridge_propose_handoff`／`bridge_accept_handoff`；不会把原本内部的正文自动改发群里。新工具声明隐藏内部入口，已有原生会话可能缓存旧工具清单，但桥端仍拒绝相关调用。此前尚未派送的内部定向事件不再投递，尚未接受的 `proposed` 交接提议同步取消，防止旧提议阻塞原负责人继续派工；再次开启不会复活旧提议。这只取消交接提议，不取消任务或正在执行的直属助手，原任务负责人和资源归属保持。已经进入对方原生上下文的内容不能撤回；内部助手结果或唤醒失败仍遵守内部可见边界，不向群公开错误正文、结果或任务标题。公开 `start_collaboration`、群消息广播、群静默不回复、本人私聊、各自的直属助手及其结果交付保持可用。是否重新开放由宿主配置决定，不以模型重试绕过。

网络配置属于各 Profile 的 `network.proxyPort`。Discord 示例为 `7898`，飞书示例为 `null`；平台链路缺省直连，公共配置不接受旧 `proxyPort`。`-ProxyPort` 仅显式覆盖本次宿主启动。没有指定 Agent 代理时沿用本机自己的默认环境和 CLI 配置。不会修改飞连、系统代理、隧道或它们的自启设置。

Discord 可选 `reactions`、`nativeCommands`、`presence`；飞书支持收件和送达表情，不支持后两项。飞书需要相应表情回复权限，重启仅清理当前 Bot 自己的处理中表情。功能在启动时加载，改动需重启。飞书使用文字命令，不依赖 Web 页面操作。

## 现有部署迁移到 v3

运行版本不自动解释 v2 的共用数据库。使用 `host-migration-cli` 离线规划、备份和拆分；该工具不连接平台或模型，身份、账号和群映射仍须核实。

1. 先构建新代码，用 `--dry-run` 检查计划。重复 `--profile` 明确最终同平台启动集合；源数据中其他 Bot 用 `--include-profile` 纳入迁移，它们不会因此启动。多活动账号必须用 `--owner botId=原始账号ID` 选择保留谁；只有核实为同一操作者才使用相同的 `--principal`。

```powershell
& .\.local\runtime\win-x64\node.exe .\dist\src\host-migration-cli.js `
  --config 'C:\SuchProject\Other\agent-bridge\.local\config.json' --dry-run `
  --profile feishu/bot1 --profile feishu/bot2 `
  --owner 'feishu:cli_APP1=ou_OWNER_IN_APP1' --principal 'feishu:cli_APP1=me' `
  --owner 'feishu:cli_APP2=ou_OWNER_IN_APP2' --principal 'feishu:cli_APP2=me'
```

2. 核对计划中的 Bot、owner、上下文路径、记录计数、冻结项与 `blockers`。正常停止桥及监督进程，核实本机和远端执行状态。工具拒绝仍在执行或结果未知的任务、主控 job、已触发计划和收件记录；停止标记与进程锁也必须通过。不能删记录、改状态、删除锁或伪造 `disabled` 来强清阻塞；先取得真实停止证据并处理原状态。
对于旧 Windows 本机 Codex job，若原记录为 `uncertain`、worker 已冻结、TaskRegistry 已失败／取消并关闭回唤，且笔记本在执行后已真正重启，可以只解除该条迁移阻断，保留未知历史。只读生成器现场核对 Windows 身份、重启时间、精确关联进程、原生最后一轮 `task_started/task_complete`、源登记和凭据文件；它不接受 proof 中自报的进程状态代替现场检查。

```powershell
& .\.local\runtime\win-x64\node.exe .\dist\src\host-migration-cli.js `
  --config '<v2 配置绝对路径>' --profile feishu/bot1 --profile feishu/bot2 `
  --include-profile discord/legacy `
  --inspect-stopped-job '<旧 job UUID>' --native-session '<原 Codex rollout JSONL 绝对路径>' `
  | Set-Content -LiteralPath '<私有 proof 绝对路径>' -Encoding utf8
```

多 owner 时仍须带原计划的 `--owner`／`--principal`。核对生成器退出码再使用输出；proof 仅含标识、路径、时间和哈希，不含票据 token、凭据或聊天正文。随后在原迁移命令追加 `--stopped-proof '<私有 proof 绝对路径>'`，先 dry-run，再离线 apply。apply 取得锁后重新验证，proof 原字节、SHA256 和现场核验摘要写入备份 manifest。proof 只适用于精确匹配的一个旧本机 `controller_jobs/uncertain`；running、远端、仍有租约／关联工作、证据变动、重复或未匹配证明均拒绝。

迁移后该 job 仍为 `uncertain`，原 TaskRegistry 失败历史、已关闭的回唤和 worker `blocked` 保留；不重跑、不追加完成事件、不转交旧 worker。原生完成只证明该轮结束；后续同机重启证明旧本机进程不能仍存活。任务是否完成、已发生的改动以及是否曾在其他电脑／服务启动后台活动，仍需人工核对，证明不宣称业务成功。

3. 在完全静止后用相同参数将 `--dry-run` 改为 `--apply`。工具备份原配置、Profile 和数据库，拆分各 Bot 资料，写入宿主语义标记并保留历史。未选中的账号不继承主控、执行和预约权限；查看输出的冻结清单，不把冻结项理解为仍在自动运行。
4. 核对备份 manifest、生成配置和各 Bot 独立工作区，补齐已核实的操作者／群登记，再执行 `start.ps1 -Check`。确认后更新登录启动任务，并启动完整集合。

迁移中断或需回滚时保持桥停止，按备份清单调用：

```powershell
& .\.local\runtime\win-x64\node.exe .\dist\src\host-migration-cli.js --restore '<备份目录>'
```

恢复保留失败安装的数据供核对，不自动丢弃。含旧数据但缺完整迁移标记时，正式启动会拒绝；全新空部署可直接建立 v3 数据，不需要伪造一次旧版迁移。迁移远端执行器前也须空闲并停止，不能重派未知任务来验证迁移。

更早的 v1 部署先通过历史 `profile-cli.js migrate <项目绝对路径>` 完成 v1→v2；相应 `migrate-remote` 仅用于该前序身份迁移。它们不能替代上述 v3 宿主迁移，当前正式启动不接受 v2 配置。

## 飞书能力与验收边界

使用企业自建机器人和官方 Node SDK 长连接，无需公网回调。私聊先写持久收件箱再确认；群由宿主独立收件、去重和恢复。群历史只取已激活负责人的真人输入，保留原消息、点名和回复关系；不把 Bot 历史伪装成人类。群恢复不使用私聊游标。

支持文字、富文本中的文字／图片、用户图片输入，以及 Agent 图片和普通文件回传。用户普通文件输入暂未启用，会明确反馈。每轮最多 10 个附件、总量最多 100 MiB，单张图片最多 10 MiB；普通回传文件另受 `maxFileBytes` 限制。超限或部分下载失败会清理本轮临时图片。

同一频道串行发送，文字按 UTF-8 字节分片。部分发送成功或投递未知不自动重发、不重跑模型；完成表情失败不改变任务结果。平台、宿主和原生协议已有离线测试；模型连接和飞书普通群消息未 @ Bot 的实时投递，仍需在目标部署中逐项验证。只读 API 核对群成员和历史可读性，不代表多 Bot 全链路验收完成；上线前须补实测。

聊天平台权限不自动授予文档权限。执行 Agent 的浏览器、文档及应用工具沿用对应电脑已有技能或独立登记能力。
