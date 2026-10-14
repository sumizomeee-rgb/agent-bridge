# 部署与迁移

[返回项目首页](../README.md)

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

## 生成 Agent 工作区

在桥仓库运行下列脚本，`-Path` 必须是目标工作区的完整绝对路径。省略参数时会询问路径；不依赖当前目录、Node 或联网。

```powershell
.\init-workspace.ps1 -Path 'D:\Agent Workspace'
```

生成 `AGENTS.md`、`CLAUDE.md`、`README.md`、`agents.json`、`capabilities.json` 和各自的 `.example.json`。只创建缺失文件，已有文件原样保留，重复运行可以补齐模板；不会改 `.local/config.json`、复制技能或迁移认证。脚本报错时返回非零退出码。

1. 在生成的 `README.md` 填写电脑用途、项目与 SSH 导航、需要初始化读取的本机入口；长工作指南只指向权威文档。
2. `agents.json` 初始为有效的空注册表，本机 `local` 由桥内置。参考 `agents.example.json` 填写真实远端登记，替换示例的电脑名称、SSH 配置、别名、引擎和路径；示例不会自动激活。SSH 凭据仍留在 SSH 配置库，供应商和认证留在对应电脑的 CLI。
3. `capabilities.json` 初始为空；按 `capabilities.example.json` 填写真正使用的浏览器 profile 和能力入口。验收记录注明范围，当前状态由桥按需查询，示例不会启用；见[能力登记与就绪检查](capabilities.md)。
4. 把 `.local/config.json` 的 `workspace` 设为该绝对路径。已运行桥需安全重启加载配置；当前用户也可用 `/cwd 完整绝对路径` 在新工作区开启会话。

工作区文件属于用户资料，需要单独迁移；保留旧工作区就直接复制它，不必重新生成或覆盖。修改模板不会更新现有工作区。

## 工作目录与数据

桥代码与 Agent 默认工作目录独立。桥基础 prompt 只定义能力、授权边界和消息/任务生命周期；用户语言、交流与执行偏好、机器与项目导航、初始化入口和摘要要求由实际工作区的 `AGENTS.md`、`README.md` 维护。业务详细习惯按工作区导航在相关任务中读取，不复制到桥。仓库 `workspace-template/` 仅是可手动采用的通用模板，运行时不会自动复制或覆盖用户文件。

技能名称、描述和路径由 CLI 根据自身系统、用户及启用的插件技能生成，不由桥扫描或拼装，也不是工作区初始化摘要。控制器使用隔离 home 保留用户供应商和模型路由，限制电脑工具与用户 MCP；隔离并不保证没有 CLI 技能元数据。桥不为上下文分层关闭或删除用户技能、不改全局设置。执行端项目指令（例如 Codex 的 `AGENTS.md`、Claude 的 `CLAUDE.md` 引用）由 CLI 自身加载；README 和其他初始化资料由调查子 Agent 按用户入口读取。

`/new` 不注入旧聊天摘要；正常原生续接保留历史。首次切换运行模式可用迁移文件或近期用户消息作为历史参考，属于一次性迁移输入，不是用户偏好的维护入口。

`.local/`、`node_modules/`、`dist/` 不进入 Git：

- `.local/config.json`：version:2 公共设置，CLI、工作区、默认启动 Profile。
- `.local/bots/<平台>/<名称>.json`：对应 bot 的凭据、应用身份、白名单及启动功能。

旧部署升级须先按 [Profile 语义迁移](profiles.md) 离线迁移数据，再改部署目录和登录任务；新运行版本不自动解释旧配置或旧归属。
- `.local/runtime/win-x64/node.exe`：Node 24.13.0 便携运行时。
- `.local/data/bridge.sqlite`：会话、当前绑定、消息去重、队列和上一条成功回复标识，含私聊数据，应备份。
- `.local/data/tasks.sqlite`：后台任务及完成事件；与会话数据库一起备份。
- `.local/data/contexts/`、`.local/data/tickets/`：父轮次登记凭据和单任务回执票据，只供桥及授权子任务使用。
- `.local/data/attachments/`：会话图片，不应在会话仍使用时删除。
- `.local/data/outgoing/`：之前回传的图片及普通文件，继续支持明确引用；不自动扫描、上传或为新消息创建目录。
- `.local/logs/`：运行状态；日志不主动保存机器人 Token。
- `.local/data/capability-health/`：能力轻检查缓存，与工作区静态登记及历史验收分开，不保存网站认证。

迁移同平台时复制代码、构建和 `.local`，按新机器位置更新配置中的 CLI 和工作目录。只有目标用户本身已具有 CLI 认证才可使用，不迁移 CLI 登录 Token。


## 跨电脑直属 Agent

在实际工作区维护 `agents.json`（`version: 1`），格式见 `workspace-template/agents.example.json`。每项记录稳定的目标 id、电脑名称、桥电脑上的 SSH 配置和别名、目标运行目录、Node 路径，以及该电脑已安装引擎的命令和默认工作目录。只存导航和非秘密登记；登录、供应商及模型别名保留在目标用户自己的 CLI 配置中。本机使用保留目标 `local`，无需重复登记。

主控按需使用 `bridge_list_targets` 查询，再在 `bridge_start_worker` 指定 `targetId`。登记不等于实时在线，派发时核对目标电脑、引擎和远端目录；不会因目标失败而悄悄改在本机执行。远端执行器运行在目标电脑，在自己的 `.local/remote` 保存任务、原生会话与回执，管理接口仅监听目标机 127.0.0.1，通过 SSH 本地转发和私有认证连接；连接元数据由 SSH 内部读取，不写进登记表。断线重连和桥恢复查询同一派发编号，不重复提交原任务。续接、工作中补充、停止、任务数字表情、读图与文件回传共用既有能力；远端产物下载到桥的 `.local/data/outgoing/remote` 后回传。

目标机放置已构建代码和 `package.json`，在 `<运行目录>/.local/remote/config.json` 写入 `version`、`expectedHostname`、可选 `proxyPort` 和与登记一致的 `engines`。以目标用户的独立登录启动任务运行 `scripts/start-remote-agent.ps1 -Root <运行目录> -NodePath <目标Node>`，使用该用户原有 CLI、认证和技能；执行器不需要 Discord Token。执行任务采用与本机直属 Agent 相同的全权限参数。

`bridge_handoff_worker` 仅对空闲且已确认结束的原生会话交接，返回目标、原生 ID、目录和目标机的继续对话命令。交接后所有权转给用户，桥不再续接或补充该子会话。交接的是目标 CLI 自己保存的真实会话，不复制会话文件；默认会话选择器是否展示由该 CLI 的来源筛选决定。
