# Agent Bridge

在 Windows 笔记本运行，一个宿主可启动同一平台的多个 Discord 或飞书 Bot。每个 Bot 只服务一个激活账号，其私聊和已激活工作群共用本 Bot 的当前主控；不同 Bot 的任务和原生会话独立；使用同一工作区时共享用户资料。支持图片、文件回传、后台助手及预约，正常重启保留会话和未启动队列。派工按电脑统一选择普通／预设助手，`/default agentworker` 可为各电脑保存默认；桥电脑初始跟随主控，远端须显式设置默认。普通新会话直接载入共享 README／MEMORY 原文，不启动初始化助手；`/new c`（`/new continue`）只派一个历史续接助手，使用桥电脑当前默认（含预设）。

群聊与连续 Agent 交接已有自动化验证；真实飞书首次激活、不 @ 消息的双 Bot 回复及后续收敛已现场验收。复杂派工、媒体、跨 Agent 往返和 Discord 真机验收仍以唯一设计稿中的范围为准。旧原生会话还需分别核对工具表，能够普通回复不等于新工具已加载。

## 部署与生成工作区

已验证平台为 Windows x64。目标用户需要已配置 Codex CLI 和 Claude Code；供应商、认证和模型别名沿用自己的 CLI / CC Switch 设置。

1. 获取代码、编译后的 `dist/` 与 `harness/` 提示词资源，复制同平台 `node_modules/` 和 `.local/runtime/`。
2. 将 `config.example.json` 复制为 `.local/config.json`，使用 `version: 3`、CLI 路径和同平台的 `startupProfiles` 集合；把 `profiles/` 中模板复制到 `.local/bots/<平台>/<名称>.json`，填写各 Bot 的真实应用 ID、凭据和白名单。明确登记 `principals` 的账号映射；飞书工作群还需 `spaces` 的逐应用群地址。
3. 生成用户上下文工作区，在其 `MEMORY.md` 填写本地约定与环境导航；多个 Bot 可共用同一目录。默认路径为 `<workspaceRoot>/<平台>/<应用ID>`，也可在对应 Profile 的 `workspace` 指定绝对路径：

```powershell
.\init-workspace.ps1 -Path 'D:\Agent Workspace'
```

4. 现有 v2 数据先按[宿主迁移](docs/profiles.md#现有部署迁移到-v3)预览、正常停桥并离线应用。运行 `.\start.ps1 -Check` 做离线配置和路径检查，再运行 `.\start.ps1` 启动完整集合；代理按各 Profile 的 `network.proxyPort` 配置，也可显式临时用 `.\start.ps1 -ProxyPort 7898`。
5. 需要登录后隐藏启动：以管理员运行 `.\install-startup.ps1 -StartNow`；手动停用用 `.\stop.ps1`。

生成脚本不需要 Node 或联网，只补缺失文件（包括按职责划分的子目录），已有文件原样保留。空的电脑、能力和预设清单可以直接使用；生成器也预建 `bridge-agent-presets/private/profiles.json`、`credentials.json` 两份空配置，新建私有目录仅当前用户和 SYSTEM 可访问。电脑、能力和预设清单参考对应 `example.json`；预设启动配置与凭据只在工作区填写，桥启动后按目标自动准备远端文件，离线目标后续重试。详细前置条件、迁移及登记步骤见 [部署说明](docs/deployment.md)。

## 目录导航

```text
agent-bridge/
├─ README.md                  项目入口
├─ init-workspace.ps1          生成用户上下文工作区
├─ start.ps1 / stop.ps1        启动 / 手动停用
├─ install-startup.ps1         登录后后台启动
├─ config.example.json        公共配置示例
├─ profiles/                  Discord / 飞书 bot 配置模板
├─ runtime-manifest.json      已验证运行时信息
├─ package.json / package-lock.json
├─ docs/                      使用、部署和开发说明
├─ harness/                   内置提示词目录及用途、生效时机
├─ workspace-template/        通用上下文、聊天平台指南与注册表模板
├─ scripts/                   监督进程、远端执行器与任务辅助脚本
├─ src/                       桥源码
├─ test/                      自动化测试
├─ dist/ / node_modules/      构建及依赖，不进 Git
└─ .local/                    运行时、配置、会话、日志与备份，不进 Git
```

用户上下文工作区独立于桥代码，可由多个 Bot 共用同一目录。账号、当前主控、助手归属和运行数据仍按 Bot ID 隔离。工程执行目录另由 `workingCwd` 或私聊 `/cwd` 选择，初始化与登记仍从固定上下文工作区读取：

```text
D:\Agent Workspace/
├─ MEMORY.md                  用户偏好、本地工作约定、环境与入口
├─ README.md                  桥通用主控规则、工具使用与初始化约定
├─ bridge-remote-agents/             远程电脑及 Agent 的非秘密登记
│  ├─ registry.json           实际登记，默认空表
│  └─ example.json            填写示例，不自动启用
├─ bridge-agent-presets/             固定电脑、供应商和模型的派工预设
│  ├─ registry.json           实际预设清单，默认空表
│  ├─ example.json            清单示例，不自动启用
│  └─ private/                profiles.json 启动配置、credentials.json 凭据
├─ bridge-capabilities/              浏览器／应用能力及历史验收登记
│  ├─ registry.json           实际登记，默认空表
│  └─ example.json            填写示例，不自动启用
├─ bridge-chat-platforms/            lark.md、discord.md，执行助手按当前平台和任务读取
├─ bridge-transaction-sync/          跨平台事务同步的可读正文
└─ tmp/                       按任务收纳临时材料与待交付附件
```

工作区 Markdown 骨架为 2 + 平台数：README 保存桥通用规则与 harness，MEMORY 保存用户偏好、本地工作约定和环境入口，每个平台另有一份指南。根目录不放临时产物，生成器预建根目录 `tmp/`；收工规则见工作区 README。机器导航和个人工作习惯放在工作区；技能由各电脑的 CLI 加载。桥提供执行能力，不复制个人指南、技能或认证到项目模板。


### 工作区职责与生成原理

工作区根目录保留 `README.md`、`MEMORY.md` 和按职责命名的目录。README 保存跨电脑、跨机器人通用的主控规则与初始化约定；MEMORY 分为“用户偏好”“本地工作约定”“环境与入口”，保存本地可变上下文；`bridge-chat-platforms/` 提供按当前平台选择的操作指南。`bridge-remote-agents/` 保存远程电脑、SSH 配置路径与 CLI 导航；`bridge-capabilities/` 保存能力入口与有范围的历史验收，实时健康检查仍由桥负责。`bridge-agent-presets/registry.json` 保存预设及目标引用，`bridge-agent-presets/private/` 保存启动配置和凭据，由桥按目标自动准备远端运行资料。清单由程序按需读取，不作为初始化全文注入；示例不会自动启用，非秘密登记表不含凭据，私有凭据也不注入主控正文。

`workspace-template/` 是随代码维护的公共骨架，`init-workspace.ps1 -Path <绝对目录>` 按固定清单复制缺失文件并预建职能目录和根目录 `tmp/`。生成前先检查目录／文件碰撞；已有用户文件保持原字节，不覆盖、不自动同步模板，也不扫描任意新增目录。桥运行时不生成工作区；直接完整载入 README 和 MEMORY，平台文档及其他资料留给执行助手按需读取。更新已有工作区时保留用户手动修改，仅同步通用 README，不覆盖本地 MEMORY 或私有登记；下一轮刷新规则时保留原生会话。共享目录迁移后 `/new` 不再继承旧 Bot 默认目录；通过 `/cwd` 明确选择的工程目录继续保留。

新增职能先与用户对齐，使用 `bridge-` 前缀、英文小写及短横线目录名，一目录承担一项稳定职责。在工作区 README 写明用途、维护者、文件格式、何时读取以及权威来源；默认按需读取，不自动加入初始化。若需提供公共骨架，将无秘密的最小模板加入 `workspace-template/<职能>/`，同步生成器的目录／文件清单、程序读取路径和相应测试，再更新本节。临时脚本、日志、截图、调查材料和待发送附件统一放 `tmp/<任务名>/`，不另建收纳分类，不占根目录或职能登记目录；在用及未交付材料保留，确认无用后移入回收站。

旧工作区升级先安全停桥并核对现有资料，将根目录 `agents.json`、`agents.example.json` 分别移动至 `bridge-remote-agents/registry.json`、`bridge-remote-agents/example.json`；将 `capabilities.json`、`capabilities.example.json` 分别移动至 `bridge-capabilities/registry.json`、`bridge-capabilities/example.json`，更新已有 README 引用后再运行生成器并重启。目标已存在时先人工核对合并，禁止覆盖；生成器发现旧登记会报错，避免创建空表后静默忽略原配置。

## 使用与维护

- [Profile、Bot 与宿主迁移](docs/profiles.md)：v3 启动集合、共享或独立的用户工作区、账号及群映射、私有资料和离线迁移。

- [使用说明](docs/usage.md)：主控与子 Agent、私聊指令、图片和文件、模型及强度、任务计数与安全重启。
- [部署与迁移](docs/deployment.md)：工作区生成、配置、代理、数据迁移与跨电脑登记。
- [能力登记与就绪检查](docs/capabilities.md)：启动体检、按需查询、验收范围和任务进度。
- [开发与验证](docs/development.md)：构建、测试和版本升级。
- [群聊与多个长期主控 Bot](docs/group-controller-design.md)：唯一群聊设计稿，统一当前主控、单操作者、多群、命令与交接边界及验收要求。

主控错误反馈与用户短通知分别持久记账。汇总、投递、启动或重启中断等回执会在同一 Bot、会话、原生绑定及聊天范围内，随主控下一轮输入有界提供；成功处理该轮后确认接收，失败保留待交付。异步补充指令发送失败也进入此记录。反馈不新建授权、不自动唤醒、不重放原任务，发送状态未知不盲重发。`bridge_read_feedback` 可按需读取更多记录；已有 Codex 工具表可通过 `bridge_list_workers` 的 `details:true` 同时读取待交付错误，因此自动反馈与兼容查询无需 `/new`。工作区与用户级偏好文档不参与此运行状态。

派工工具失败另登记持久待处理清单，不能以“错误已送达”、普通回复或 `DONE` 自动清除。桥每 30 秒检查，只在同一主控空闲且存在待处理失败时合并提醒；普通运行、排队助手不触发这种唤醒。主控用 `bridge_list_dispatch_failures` 查询、`bridge_ack_dispatch_failure` 按 ID 点掉并保留历史，桥不自动重放派工。连续三次复核没有处理则通知用户一次并暂停该项提醒；`/stop`、`/new` 停止旧绑定提醒。

新增或改变主控工具声明后，已有 Codex 原生会话的工具表不会随普通重启更新；需要时用私聊 `/new continue` 提炼最新上下文并建立新工具会话，该命令仍会取消旧预约。Claude 主控重启时按当前 MCP 工具及提示重建进程并续接原生会话，是否免于 `/new` 须用新工具实际调用及相同 nativeId 验证，不能只看普通回复。模板更新不会覆盖用户资料；README／MEMORY 更新在下一轮完整刷新并保留原生会话，无需 `/new`。私聊 `/new continue` 仅提炼本 Bot 当前主控，并取消旧预约；真实 `/agent` 切换自动交接最新上下文，保留助手和计划，目标准备失败时保持旧主控。普通模型、强度切换保留当前会话。

执行助手的固定电脑、供应商与模型预设见 [派发预设](docs/presets.md)。上下文工作区统一维护预设清单及 `bridge-agent-presets/private/` 下的启动配置和凭据；桥复用已登记电脑与执行器，启动后自动准备相应文件，不要求用户逐台维护预设。个人清单和凭据不入 Git，主控通过现有目标查询接口按需发现预设。生成器只创建空结构，不包含真实凭据；已有工作区补缺时也不覆盖现有配置。

事务巡视按 Bot 默认关闭：私聊 `/housekeeper on|off|status` 开启、关闭或查看；开启立即检查，此后每 20 分钟读取 `bridge-transaction-sync/` 的开启后增量，无新增不派模型。各平台正文格式由同步来源决定，桥仅增量读取普通 UTF-8 文本（`.md`、`.txt`、`.log`），不解析平台协议或 JSON。每轮新建当前默认助手，直接注入有界文本增量供其按平台、事项总结；审计文件仍保留，助手无需调用工具读文件。摘要只交主控判断跟进、提醒或静默；来源失败、缺失及未读范围如实呈现。开关和消费进度跨 `/new`、重启保留，失败不前移未确认进度；`/stop` 同时关闭巡视，继续需重新开启。桥启动时及此后每24小时检查公开同步目录，超量时分批续清；按文件原发布时间（mtime）将超过10天的 `.md`、`.txt`、`.log` 移入系统回收站；不受巡视开关影响，不清理同步器内部原始存档，回收失败不改为永久删除。保留期清理不作为内容撤回通知主控。

`harness/prompts.toml` 集中维护内置提示词，每项标明用途、受众、注入时机、生效条件、来源及正文；工作区 README 的通用行为句也从这里生成。动态取词在下次取用时读取，模块启动常量需重启，已有 Codex 工具声明还需 `/new c` 重建；具体以条目 `activation` 为准。工程和执行器部署必须携带 `harness/`，不能只复制 `dist/`。目录与编辑规则见 [harness/README.md](harness/README.md)。

管家事务真实路径的隔离单轮验收：

```powershell
node scripts/controller-lab/housekeeper-live.mjs --runtime-root <候选工程绝对目录> --source-root <生产工程绝对目录> --config <生产配置绝对路径>
```

该脚本使用真实 Bot／Host／主控、保存的默认助手及事务读取路径，平台发送落在隔离 sink；测试主控为 `gpt-6-luna xhigh`，摘要助手沿用当前笔记本默认 `gpt-6.1-sol xhigh`。仅扫描三个平台的至多 12 个文本片段／12000 字有界历史样本，验证回传确认、关闭和重建持久化；它不代表全量语义验收，也不修改生产开关或会话。结果保存为独立目录的 `report.json`、`result.md`。
