# 部署与迁移

[返回项目首页](../README.md)

## 部署

正式 bootstrap 为 `version:4`，只保存明确的 `workspaceRoot`、CLI 命令和公共运行选项。主控、启动集合、操作者及可选渠道登记均放在工作区，完整配置见 [主控与渠道登记](controller-registry.md)。运行时不读取旧 `.local/bots/`，不按平台派生新工作区，也不回退旧数据路径。

1. 准备同平台 Node `>=24.12.0`、`node_modules/`、构建后的 `dist/`、`harness/`、脚本与工作区骨架。CLI 使用目标用户自己的认证、网关和 skills。
2. 运行 `.\init-workspace.ps1 -Path 'D:\Agent Workspace'`。生成器只补缺失文件，保留已有 README、MEMORY 与私有登记；不自动改 bootstrap。
3. 复制 `config.example.json` 为项目 `.local/config.json`，填写 CLI 与工作区路径，在工作区完成主控和渠道登记。真实配置、凭据和运行数据不进 Git。
4. 已有部署先正常排空并停止旧桥，再执行 [v4 离线迁移](controller-registry.md#旧部署的一次性迁移)。不能用新脚本控制仍在旧目录运行的进程。
5. 运行 `.\start.ps1 -Check`，再运行 `.\start.ps1`。检查只证明静态配置和本机路径，不验证平台、网关或模型当前可用。
6. 需要登录后隐藏启动时，以管理员运行 `.\install-startup.ps1 -StartNow`。

`-Profile` 接受启动主控 ID 或其已绑定渠道的 profile 名，只校验集合成员，不单独启动该成员；`-Platform` 核对已配置渠道，不更改启动集合。无渠道主控可使用不带平台的启动方式。

主控与聊天渠道各自的 `network.proxyPort` 独立生效；`-ProxyPort` 是明确的临时覆盖。配置不修改飞连、系统代理或隧道自启。`internalBotCommunicationEnabled` 控制跨 Bot 后台协作，不取消在执行的直属助手或改变平台发送授权。

## 工作区、停止与重启

工作区 `README.md` 是固定初始化上下文的唯一入口；MEMORY 由其中显式引用载入。部署说明、外部 API 和登记细节按需阅读，不额外灌入主控。

- `bridge-local/host/`：宿主库、收件与重启状态、PID、停止请求、`host.log`、`logs/startup-errors.log` 和外部 API 私有登记。
- `bridge-registry/controllers/<id>/data/`：主控会话、助手、任务、定时、恢复、上下文票据及原生主控运行资料。
- `bridge-registry/channels/lark|discord/bots/<appId>/data/`：渠道 ingress、outbox、生命周期和附件。渠道凭据在同级 `credentials.json`。
- `bridge-local/browser/`：桥的浏览器运行资料；`bridge-computers/` 保存电脑与 SSH 登记。
- `tmp/<任务名>/`：临时产物；以上持久目录不视为可清理 tmp。

`.\stop.ps1` 写入宿主 `disabled` 和停止请求，让监督任务停止重启。`.\stop.ps1 -Drain` 暂停接新工作并等待已有执行安全结束；未确认进程停止时不强杀。手动 `.\start.ps1` 重新启用，监督和安全重启沿用同一个宿主目录及日志目录。

普通重启保留主控原生会话、任务和定时；外部 Agent 的等待决策持久化，重新连接后使用当前 lease 继续。期限按原 deadline 计算，不因重启重新计时；执行中结果未知不会自动重放副作用。`/new` 是新建主控会话，与重启不同；待触发计划沿用既有的持久生命周期规则。

迁往同平台新电脑时，先正常停桥，搬迁代码、发行资产、bootstrap 和唯一工作区，再更新 CLI 路径及明确的工作区入口。跨机器 CLI 登录仍由目标用户准备；不要只搬其中某个数据库或遗失渠道凭据、签名票据。

## 跨电脑直属 Agent

在实际工作区维护 `bridge-computers/registry.json`（`version: 1`），格式见 `workspace-template/bridge-computers/example.json`。每项记录稳定的目标 id、电脑名称、桥电脑上的 SSH 配置和别名、目标运行目录、Node 路径，以及该电脑已安装引擎的命令和默认工作目录。只存导航和非秘密登记；登录、供应商及模型别名保留在目标用户自己的 CLI 配置中。本机使用保留目标 `local`，无需重复登记。

主控按需使用 `bridge_list_targets` 查询，再在 `bridge_start_worker` 指定 `targetId`。登记不等于实时在线，派发时核对目标电脑、引擎和远端目录；不会因目标失败而悄悄改在本机执行。远端执行器在自己的 `.local/remote` 保存任务登记与回执；助手历史由原生 CLI 保存在对应用户的 `.codex/sessions`、`.claude/projects` 及原生索引，`.codex/bridge/`、`.claude/bridge/` 只保留绑定、共享预设配置与运行时。显隐通过原生来源筛选实现，详见[预设与原生历史](presets.md#原生历史可见性)。管理接口仅监听目标机 127.0.0.1，通过 SSH 本地转发和私有认证连接。断线重连和桥恢复查询同一派发编号，不重复提交原任务。续接、工作中补充、停止、读图与文件回传沿用既有协议。

目标机首次安装时放置已构建代码和 `package.json`，在 `<运行目录>/.local/remote/config.json` 写入 `version`、`expectedHostname`、可选 `proxyPort` 和与登记一致的 `engines`。以目标用户的独立登录启动任务运行 `scripts/start-remote-agent.ps1 -Root <运行目录> -NodePath <目标Node>`，使用该用户原有 CLI、认证和技能；执行器不需要 Discord Token。执行任务采用与本机直属 Agent 相同的全权限参数。

已登记的 Windows 执行器由桥自动维护程序版本：宿主启动时后台检查一次，后续派工握手前按需检查；离线或忙碌目标在下次派工检查时重试，不做定时轮询。并发检查等待同一个更新操作；离线目标不阻挡其他 Bot 就绪。发布包只包含程序、启动器和依赖，使用校验和检查，在目标 `.local/remote/releases/<内容摘要>` 保存独立版本，通过 `active-release.json` 切换。工作区、原生认证、网关设置、会话和任务数据不随程序发布覆盖。预设所需运行资料由独立的自动准备步骤从上下文工作区按目标下发到受限私有目录；用户仍只维护工作区配置。原生 CLI 配置和旧预设资料不覆盖，更新与新派工沿用现有任务安全边界。详见[执行助手预设](presets.md)。

执行器仍有运行任务、未确认结果、未退出进程或原生查询时延后更新。新执行器用维护租约暂停新派工并正常退出，登录任务自动加载所选版本；旧执行器首次接入时要求持久日志证明空闲，核对唯一进程身份及无原生子进程后，只停止空闲执行器本身。新版本未能就绪时恢复上次版本指针和启动器，不强杀可能已经接手任务的进程。更新阶段只写宿主诊断日志，不增加常态平台通知；协议能力仍在实际派工前核验，不自动忽略新参数或重派已接收的任务。缺少初始登记、运行时、语义迁移或唯一登录任务时报告待处理，不能伪造已安装或已升级。

`bridge_handoff_worker` 仅对空闲且已确认结束的原生会话交接，返回目标、原生 ID、目录和目标机的继续对话命令。命令自动加载原助手的模型、强度、预设及显隐配置，凭据仍从目标机读取。交接后所有权转给用户；用户退出 CLI 后，主控可读取并通过 `bridge_adopt_native_session` 接回，再继续同一原生会话，可反复交还与接回。旧持有者和过期交接命令不能继续使用。普通、预设及隐藏助手均支持，不复制会话文件，不修改全局配置。
