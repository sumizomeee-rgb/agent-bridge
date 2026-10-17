# Agent Bridge

在 Windows 笔记本运行，一个宿主可启动同一平台的多个 Discord 或飞书 Bot。每个 Bot 只服务一个激活账号，其私聊和已激活工作群共用本 Bot 的当前主控；不同 Bot 的记忆、任务和原生会话独立。支持图片、文件回传、后台助手及预约，正常重启保留会话和未启动队列。

群聊与连续 Agent 交接已有自动化验证；真实飞书首次激活、不 @ 消息的双 Bot 回复及后续收敛已现场验收。复杂派工、媒体、跨 Agent 往返和 Discord 真机验收仍以唯一设计稿中的范围为准。旧原生会话还需分别核对工具表，能够普通回复不等于新工具已加载。

## 部署与生成工作区

已验证平台为 Windows x64。目标用户需要已配置 Codex CLI 和 Claude Code；供应商、认证和模型别名沿用自己的 CLI / CC Switch 设置。

1. 获取代码及编译后的 `dist/`，复制同平台 `node_modules/` 和 `.local/runtime/`。
2. 将 `config.example.json` 复制为 `.local/config.json`，使用 `version: 3`、CLI 路径和同平台的 `startupProfiles` 集合；把 `profiles/` 中模板复制到 `.local/bots/<平台>/<名称>.json`，填写各 Bot 的真实应用 ID、凭据和白名单。明确登记 `principals` 的账号映射；飞书工作群还需 `spaces` 的逐应用群地址。
3. 为每个 Bot 生成独立上下文工作区，在其 `README.md` 填写导航。默认路径为 `<workspaceRoot>/<平台>/<应用ID>`，也可在对应 Profile 的 `workspace` 指定绝对路径：

```powershell
.\init-workspace.ps1 -Path 'D:\Agent Workspace'
```

4. 现有 v2 数据先按[宿主迁移](docs/profiles.md#现有部署迁移到-v3)预览、正常停桥并离线应用。运行 `.\start.ps1 -Check` 做离线配置和路径检查，再运行 `.\start.ps1` 启动完整集合；代理按各 Profile 的 `network.proxyPort` 配置，也可显式临时用 `.\start.ps1 -ProxyPort 7898`。
5. 需要登录后隐藏启动：以管理员运行 `.\install-startup.ps1 -StartNow`；手动停用用 `.\stop.ps1`。

生成脚本不需要 Node 或联网，只补缺失文件（包括按职责划分的子目录），已有文件原样保留。空 `remote-agents/registry.json`、`capabilities/registry.json` 可以直接使用；远端和能力登记参考各自的 `.example.json` 填写。详细前置条件、迁移及登记步骤见 [部署说明](docs/deployment.md)。

## 目录导航

```text
agent-bridge/
├─ README.md                  项目入口
├─ init-workspace.ps1          生成独立 Agent 工作区
├─ start.ps1 / stop.ps1        启动 / 手动停用
├─ install-startup.ps1         登录后后台启动
├─ config.example.json        公共配置示例
├─ profiles/                  Discord / 飞书 bot 配置模板
├─ runtime-manifest.json      已验证运行时信息
├─ package.json / package-lock.json
├─ docs/                      使用、部署和开发说明
├─ workspace-template/        通用上下文、聊天平台指南与注册表模板
├─ scripts/                   监督进程、远端执行器与任务辅助脚本
├─ src/                       桥源码
├─ test/                      自动化测试
├─ dist/ / node_modules/      构建及依赖，不进 Git
└─ .local/                    运行时、配置、会话、日志与备份，不进 Git
```

每个 Bot 的上下文工作区独立于桥代码，可放在指定目录；不同 Bot 不能共用或嵌套同一上下文目录。工程执行目录另由 `workingCwd` 或私聊 `/cwd` 选择，初始化与登记仍从固定上下文工作区读取：

```text
D:\Agent Workspace/
├─ MEMORY.md                  持续维护的偏好、纠正与已核实事实
├─ README.md                  稳定行为约定、初始化入口与工作导航
├─ remote-agents/             远程电脑及 Agent 的非秘密登记
│  ├─ registry.json           实际登记，默认空表
│  └─ example.json            填写示例，不自动启用
├─ capabilities/              浏览器／应用能力及历史验收登记
│  ├─ registry.json           实际登记，默认空表
│  └─ example.json            填写示例，不自动启用
├─ chat-platforms/            lark.md、discord.md，初始化只读当前平台
└─ .local/                    tmp/ 临时产物、deliveries/ 正式交付
```

工作区 Markdown 骨架为 2 + 平台数：README 统一保存稳定约定与导航，MEMORY 保存持续记忆，每个平台另有一份指南。根目录不放临时产物，生成器预建 `.local/tmp/` 与 `.local/deliveries/`；收工规则见工作区 README。机器导航和个人工作习惯放在工作区；技能由各电脑的 CLI 加载。桥提供执行能力，不复制个人指南、技能或认证到项目模板。


### 工作区职责与生成原理

工作区根目录保留 `README.md`、`MEMORY.md` 和按职责命名的目录。README 是初始化与规则的唯一入口，MEMORY 记录长期偏好和已核实事实；`chat-platforms/` 提供按当前平台选择的操作指南。`remote-agents/` 保存远程电脑、SSH 配置路径与 CLI 导航；`capabilities/` 保存能力入口与有范围的历史验收，实时健康检查仍由桥负责。这两类 JSON 由程序按需读取，不作为初始化全文注入；示例不会自动启用，任何登记都不包含凭据。

`workspace-template/` 是随代码维护的公共骨架，`init-workspace.ps1 -Path <绝对目录>` 按固定清单复制缺失文件并预建职能目录和 `.local/tmp/`、`.local/deliveries/`。生成前先检查目录／文件碰撞；已有用户文件保持原字节，不覆盖、不自动同步模板，也不扫描任意新增目录。桥运行时不生成工作区；初始化只读 README 指定的 MEMORY 和当前平台文档，其余资料按任务和工具需要读取。更新已有 README 时需保留用户内容并定点合并，新会话重新初始化后生效。

新增职能时使用英文小写、短横线目录名，一目录承担一项稳定职责。在工作区 README 写明用途、维护者、文件格式、何时读取以及权威来源；默认按需读取，不自动加入初始化。若需提供公共骨架，将无秘密的最小模板加入 `workspace-template/<职能>/`，同步生成器的目录／文件清单、程序读取路径和相应测试，再更新本节。任务产物进 `.local/tmp/<任务名>/`，保留交付进 `.local/deliveries/<任务名>/`，不占根目录或职能登记目录。

旧工作区升级先停桥并备份，将根目录 `agents.json`、`agents.example.json` 分别移动至 `remote-agents/registry.json`、`remote-agents/example.json`；将 `capabilities.json`、`capabilities.example.json` 分别移动至 `capabilities/registry.json`、`capabilities/example.json`，更新已有 README 引用后再运行生成器并重启。目标已存在时先人工核对合并，禁止覆盖；生成器发现旧登记会报错，避免创建空表后静默忽略原配置。

## 使用与维护

- [Profile、Bot 与宿主迁移](docs/profiles.md)：v3 启动集合、独立工作区、账号及群映射、私有资料和离线迁移。

- [使用说明](docs/usage.md)：主控与子 Agent、私聊指令、图片和文件、模型及强度、任务计数与安全重启。
- [部署与迁移](docs/deployment.md)：工作区生成、配置、代理、数据迁移与跨电脑登记。
- [能力登记与就绪检查](docs/capabilities.md)：启动体检、按需查询、验收范围和任务进度。
- [开发与验证](docs/development.md)：构建、测试和版本升级。
- [群聊与多个长期主控 Bot](docs/group-controller-design.md)：唯一群聊设计稿，统一当前主控、单操作者、多群、命令与交接边界及验收要求。

新增或改变主控工具声明后，已有 Codex 原生会话的工具表不会随普通重启更新；需要时用私聊 `/new continue` 提炼最新上下文并建立新工具会话，该命令仍会取消旧预约。Claude 主控重启时按当前 MCP 工具及提示重建进程并续接原生会话，是否免于 `/new` 须用新工具实际调用及相同 nativeId 验证，不能只看普通回复。模板更新不会覆盖用户资料，更新个人上下文后用 `/new` 重新初始化。私聊 `/new continue` 仅提炼本 Bot 当前主控，并取消旧预约；真实 `/agent` 切换自动交接最新上下文，保留助手和计划，目标准备失败时保持旧主控。普通模型、强度切换保留当前会话。
