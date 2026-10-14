# 飞书通信适配可行性与开发边界

[返回项目首页](../README.md)

查证日期：2026-10-14。项目现状基于当时工作树（HEAD `ca38928`）的源码与现有文档；本文件记录调研和设计决定，不表示适配器已经实现。

## 结论与验证范围

飞书企业自建应用机器人可以作为本桥的另一个通信入口。官方支持私聊消息接收、应用身份主动发送、图片和文件资源，以及无需公网入站地址的长连接。现有桥已经把部分通信行为收敛到 `BridgeMessage`、`ReplySink`，命令与 Agent 调度可复用，但收件游标、身份配置、启动锁和输出格式仍绑定 Discord，不能只替换 API 地址。

本期采用**共用一个桥核心、启动时选择一个平台、同一份运行状态只允许一个桥实例**。Discord 和飞书不同时在线；未来是否同时运行多个适配器另行讨论。原生子 worker 是桥管理的执行进程，不是第二个桥实例。

已有实测与未验证项：

- 2026-10-14，目标个人企业自建应用的 1.0.1 版本正式发布，当前租户界面显示“本次发布免审核，提交发布后即可上线使用”，审核结果通过。这是该应用在该租户的结果，不是所有应用或后续权限变更的免审保证。
- 同日，以目标应用身份主动向授权用户本人发送文本私聊成功，HTTP 200、业务 `code=0`；API 发送者身份、用户 Chrome 消息回读和用户确认均通过。这里验证的是主动发送，不是用户身份代发，也不是自动接收回复。
- 已核验应用身份核心权限：`im:message`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:resource`。机器人可用范围为本人；消息接收事件 `im.message.receive_v1` 和长连接订阅配置已保留。
- 本项目尚未部署飞书事件消费者；接收、自动双向聊天、图片/文件收发、reaction、卡片按钮、断线恢复均未做本项目实测。配置存在、官方支持、实际验收成功必须分别表述。
- 已调查的另一套飞书工具网关具有文档工具和主动发送能力，未证实聊天接收实现；它使用不同应用身份，不能直接视为本桥已有飞书聊天后端或混用其凭据、资源 Key、用户 Open ID。

文档只保留开发必要事实。运行配置示例使用占位；现场导航按用户授权记录非秘密绝对路径及用于区分应用的App ID，不记录密钥、token、cookie、个人私聊正文、消息 ID 或公司审批人员。

## 现场参考部署与证据导航

2026-10-14增补：首版只概述了参考网关，未写完整物理路径。以下远端导航来自同日已登记工位/harucode调查 worker 的回执，本轮未再次SSH，不代表机器现在在线或部署未变。路径按所在机器使用，工位/harucode路径不是笔记本可直接打开的路径。后来Agent复查前须核对hostname、账号、实际root、工作树和当前部署，禁止先读取整份凭据配置。

| 所在机器 | 已核对的绝对位置或入口 | 用途与证据局限 |
| --- | --- | --- |
| 工位 `11032022110008`，账号 `11032022110008\administrator` | `E:\Such_Proj\Other\MyHaruSkills\workstation-context\SKILL.md` | 当前工位操作约定唯一入口；旧README已删除，不使用旧入口 |
| 同一工位 | `E:\Such_Proj\Other\MyHaruSkills\lark-haru\SKILL.md` | 技能入口；已核对链路为技能→`request.py`→网关。`request.py`的精确绝对路径未在已保留回执中给出，须从此技能当前正文定位，不猜它位于某个`scripts`目录 |
| 同一工位 | `E:\Such_Proj\Other\Haru-ssh-setup\hosts\harucode-template\ssh_config` | 连接harucode时使用对应`-F`配置；目标别名须读当前配置核对。本轮不记录认证/私钥内容 |
| harucode：当次hostname `template`、账号 `harucode`，当次地址 `10.101.231.215:22` | `/home/harucode/lark-haru-gateway` | 真实部署根；服务名`lark-haru-gateway.service`，当次用户服务active/running、配置模式real；不保证此刻状态 |
| 同一harucode | `/home/harucode/lark-haru-gateway/current` | 当前代码包导航；远端无Git元数据，不能用此目录断言整体版本等于某个commit |
| 同一harucode | `/home/harucode/lark-haru-gateway/.venv/lib64/python3.9/site-packages/lark_haru_gateway` | 服务实际安装实现，可供有限源码对照；当次相关7文件安装包与current一致，4核心文件与工位参考repo一致，不能外推全部署一致 |
| 同一harucode | `/home/harucode/lark-haru-gateway/config/lark-haru.config.json` | **敏感配置位置，只作导航**；含接入配置，不能整份读取、复制入桥或输出。本轮未读取明文 |
| 工位→harucode网关→飞书OpenAPI | `http://10.101.231.215:8765/v1/json` | 已核对技能请求的网关入口，端口8765；不是飞书消息接收回调，也不授权本轮调用动作 |
| 工位参考源码 | `https://github.com/sumizomeee-rgb/lark-haru-gateway`，当次`main@20da655` | 当次工位repo已跟踪文件无修改；**工位clone根绝对路径待定位**，不能用GitHub地址冒充本地物理路径 |

身份须精确区分：参考网关应用 `cli_a7a1a640d5d8d00e` 对应丽芙/Larkharu；个人BridgeBot为 `cli_a95d158b3036dcc3`。App ID是用于对齐的非秘密标识，运行实例仍从本地配置取值，不写死在实现中。不得混用两个应用的secret、token、Open ID或资源Key。

当次证据确认网关已有文档/表格/wiki/云盘工具、配置目录搜索、文档内嵌图片下载；白名单主动text/post发送曾成功，但未核实chat类型和用户可见。没有消息接收、WebSocket、会话/Agent管理、卡片按钮和聊天附件双向的实现证据；云盘上传不等于聊天附件。可参考工具封装、错误处理和部署方式，不能把它直接称为完整聊天桥或权限齐全。成功/权限错误日志的精确保留路径、完整审计回执路径未在已有回执给出，列为待定位；后来Agent应从上述部署/服务导航有限定位，不编造日志文件名。

笔记本已有实验与发布证据另在下节列明。远端参考源码与部署材料、个人bot实验、当前桥生产运行数据是三类不同来源，不能互相替代验收。

## 配置、秘密和运行数据边界

### 当前Discord实例：实际加载链与Git状态

2026-10-14本机只读审计：hostname `DESKTOP-6FVMGQD`、账号 `desktop-6fvmgqd\sumizome`，repo根 `C:\SuchProject\Other\discord-agent-bridge`。其他worker正在修改源码/测试；本节只描述当次配置及加载代码，未覆盖他们的修改，未启动或重启部署。

- 生效入口为根 `start.ps1` 或登录任务`SumizomeDiscordAgentBridge`→`scripts\supervise.ps1`，均启动 `.local\runtime\win-x64\node.exe`→`dist\src\main.js`。当次计划任务为Running；PID记录对应项目内Node进程且无`--config`覆盖参数。这是运行路径核验，未读取完整进程命令或环境到文档。
- `src/config.ts`和当前构建`dist/src/config.js`默认读取 **`C:\SuchProject\Other\discord-agent-bridge\.local\config.json`**；可以由`--config`指定其他文件，当前运行未指定。Discord token来自该JSON的`token`，没有Discord凭据环境变量或`.env`回退加载。当前`.env`不存在。
- 该真实JSON有`token`、`applicationId`、`allowedUserIds`、`controllerMode`、CLI命令路径、workspace、代理及模型选项；只核对键名/存在性，未输出真实值。token有值，白名单1人，controllerMode开启。`applicationId`虽然已落盘，当前源码和构建加载器均未消费此字段；实际application ID由Discord `READY`事件或`GET /applications/@me`获得，bot用户ID/名称由READY获得。它们可在运行内存/连接日志出现，不能把额外JSON字段当当前必需启动参数。
- 授权用户ID来自`allowedUserIds`；私聊channel/message ID来自平台事件并持久化于收件/会话/任务来源。当前仅接受bot私聊，guild输入被拒绝，没有本实例必需的guild白名单或写死的私聊channel启动字段。
- 代理环境由`agentEnvironment`在启动CLI时派生；CLI供应商认证沿用用户已有配置，和Discord token是不同凭据。控制器隔离home的创建逻辑还会复制CLI认证，不能因`.local`被忽略就把整目录当无秘密可公开迁移包。

以下位置均以当次真实配置解析，不读取数据库、附件、CLI认证或日志正文：

| 实际笔记本位置 | 内容/用途 | 当前存在与Git结果 |
| --- | --- | --- |
| `C:\SuchProject\Other\discord-agent-bridge\.local\config.json` | 真实Discord token、实例字段/白名单/CLI参数 | 存在；未tracked，根`.gitignore`的`.local/`规则命中 |
| `C:\SuchProject\Other\discord-agent-bridge\config.example.json` | 部署模板 | tracked；token/白名单为占位值，未把真实凭据或授权ID写入模板 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\bridge.sqlite` | 消息、会话绑定、原生session ID、回复投递状态 | 存在；未tracked且ignored |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\ingress.sqlite` | 原始收件、私聊来源和补取游标 | 存在；未tracked且ignored |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\controller.sqlite` | 直属worker、job、wake、补充和归属记录 | 存在；未tracked且ignored |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\tasks.sqlite`、同目录`contexts\`和`tickets\` | 后台登记、结果/回执及桥内部认证票据 | 均存在；未tracked且ignored。票据本身含认证材料，不读取/输出/提交 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\restart.sqlite`、`bridge.pid.json` | 安全重启状态、当前实例元信息 | 存在；未tracked且ignored。命名管道锁在OS内存中，不是Git文件 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\attachments` | 用户图片与回传处理的本地附件 | 存在；未tracked且ignored；本轮未打开内容 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\data\controller-homes` | CLI隔离配置/home，创建逻辑可包含认证副本 | 目录存在；未tracked且ignored；仅核对路径，不读取里面凭据 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\logs` | bridge日志与监督启动错误日志 | 存在；未tracked且ignored；不读取聊天/日志正文 |
| `C:\SuchProject\Other\discord-agent-bridge\.local\runtime\win-x64\node.exe` | 当前项目Node运行时 | 存在；未tracked且ignored |

`git ls-files -- .local .env .env.*`当次返回0项；`git check-ignore -v --no-index`对上述`.local`路径均命中根`.gitignore:1`，`.env`命中第4行。在必要的`.local`、data、runtime、logs目录未发现额外嵌套`.gitignore`。源码、启动脚本、`.gitignore`、`runtime-manifest.json`和模板已tracked，真实配置/运行数据是项目目录下的Git忽略本地文件，不是Git版本内容。本结论检查当前索引/工作树，不证明全Git历史从未泄露；本轮未扫描历史，也未发现或处置历史凭据。

Agent工作区为 `C:\SuchProject\AgentWorkspace`，与桥repo分离；当次工作区本身不是Git仓库。工位目标/能力授权来自工作区登记与各机器CLI环境，不从飞书或Discord账号名字自动推导。

### 飞书：实验记录已存，生产接入凭据尚未存

当前有效`.local/config.json`的键名及嵌套键审计未见Feishu/Lark/App Secret/tenant token字段，加载器仍仅支持Discord身份。本轮没有创建飞书配置或读取其他所有历史备份，因此结论限于**当前生效配置与已知实验**，不声称整台机器所有文件都没有飞书材料。

已核对以下实验/资产路径存在；它们不在桥repo的生产配置中：

| 笔记本绝对位置 | 已保留内容与读取边界 |
| --- | --- |
| `C:\SuchProject\AgentWorkspace\.local\experiments\feishu-bot-smoke-20261014\smoke.mjs` | 无秘密可复用模块；通过`createSmokeSession(appSecret)`只接收内存参数，tenant token保留于闭包，dispose清空。有限源码检查未见凭据字面量、文件写入、进程/监听启动 |
| 同目录 `README.md` | 当次实验过程、安全回执与官方链接。记录的是09:36实验时的1.0.0，不代替后来1.0.1发布状态；含定位所需本地身份记录，不整份复制进公共文档 |
| `C:\SuchProject\AgentWorkspace\.local\experiments\feishu-bot-smoke-20261014\.local\result.json` | 无秘密API/网页/用户验收回执；保留非秘密App ID、消息/聊天标识等。并非“完全没存bot信息”，但不是auth缓存 |
| 同实验目录 `bot-message-visible.jpg` | 精确bot私聊可见证据；含实验聊天画面，本轮不打开/复制图到repo |
| `C:\SuchProject\AgentWorkspace\.local\feishu-permission-convergence-20261014\ten-revoke-final-result.json`、`ten-revoke-diff.json`、`ten-revoke-published-1.0.1.png` | 权限收敛、版本发布差异与截图导航；本轮只检查文件存在，按需有限读取非秘密字段 |
| `C:\SuchProject\AgentWorkspace\.local\experiments\bridgebot-avatar-20261014\bridgebot-avatar.png` | 已核验并授权使用的512×512头像资产；不是接入凭据 |

当次实验回执记录App Secret/tenant token只在本机进程内存，未创建凭据文件，变量/dispose引用和剪贴板已清理。2026-10-14此次复核仅匹配实验路径的实际实验进程，残留0；没有重新读取密钥或清空用户当前剪贴板。脚本本身没有文件写入函数；回执顶层未见secret/token/cookie认证字段，这种有限核验不声称对整目录任意字节完成秘密扫描。

App凭据仍由飞书开放平台保管；本机有非秘密记录、发布证据和头像。**个人bot生产接入所需App Secret尚未保存到桥当前配置**，临时tenant token也不是可供开发Agent复用的长期凭据。本轮不新取secret、不建auth缓存、不迁移丽芙/Larkharu配置。

### 正式接入的本地布局建议（尚未实现）

沿用现有可迁移项目`.local`机制，共用任务/会话状态，不另造两套内核：

- repo仅tracked模板、字段说明和不带秘密的启动逻辑；真实Discord/Feishu身份、平台白名单和目标地址在Git忽略的本地实例配置。非秘密ID也不写死到代码或BAT。
- 可保留`.local/config.json`为通用核心/平台选择，另设`.local/platforms/discord.json`、`.local/platforms/feishu.json`用于平台字段；或在现有JSON用明确平台分组。若分离秘密，可选`.local/secrets/feishu.json`并限制当前用户访问。以上是布局选项，**本轮未创建这些文件或字段**。
- 飞书App ID＋App Secret需后续在准确自有应用身份下通过已授权原生方式安全获取并保存，不能让用户把密钥贴到聊天。不生成/重置secret，不借用网关应用材料。token由SDK在内存获取/刷新，尽量不持久化；本地文件落盘/迁移另按明确授权和目标机器边界处理，`.local`不等于可以把所有认证副本整包公开复制。
- BAT只选择platform并调用共用入口读取本地配置；密钥不嵌脚本、不进命令参数/日志。缺必要字段明确报错，不偷偷切到另一app或平台。安全日志只保留脱敏错误码和必要路由证据。
- 白名单与会话/消息/结果路由按平台、租户和app命名空间；显式跨入口续会话授权、项目单实例互斥、任务回送原入口的既有设计保持不变。
- 正式保存前后分别核对`git ls-files`与`git check-ignore`，避免“ignore规则已写”掩盖先前已tracked的文件；token、CLI认证副本、任务票据与聊天附件都需作为本地敏感数据管理。

## 项目现状与需要解耦的位置

| 位置 | 当前实现 | 飞书适配需要处理的边界 |
| --- | --- | --- |
| [src/types.ts](../src/types.ts) | `BridgeMessage` 为文本和本地图片路径；`ReplySink` 提供发送及可选任务计数、送达标识 | 增加平台身份与回复地址；把附件和平台能力表达为中性类型，避免传播 Discord REST 对象 |
| [src/manager.ts](../src/manager.ts)、[src/slash.ts](../src/slash.ts) | 统一文本命令解析、帮助、参数校验；Discord 原生 slash 先转换成文本 | 共享命令语义、权限校验和帮助；平台仅负责输入规范化及可选菜单注册 |
| [src/main.ts](../src/main.ts)、[src/discord.ts](../src/discord.ts) | 主入口直接创建 `DiscordTransport`，绑定附件下载、历史补取、发送、presence | 共用入口按平台选择适配器；平台连接故障不能复制或重建一套调度内核 |
| [src/ingress.ts](../src/ingress.ts) | 收件先持久化，按用户有序准备；游标使用 Discord Snowflake、`BigInt` 比较、最多 100 条一页 | 持久收件原则复用，ID 作为不透明值；飞书使用时间范围和分页标记，不能用数字 ID 排序 |
| [src/store.ts](../src/store.ts) | 消息 ID 全局唯一、活动会话按 `userId`、投递记录按用户/频道 | 命名空间和数据迁移需设计；不能直接把两个平台同名用户或裸 ID 合并 |
| [src/controller/runtime.ts](../src/controller/runtime.ts)、[src/tasks.ts](../src/tasks.ts) | 直属 worker、原生归属、任务/唤醒与来源校验；结果绑定父会话、用户、频道、原始消息 | 保留同一核心；给来源增加平台/应用路由，结果不得转投当前打开的另一个平台 |
| [src/reply.ts](../src/reply.ts)、[src/artifacts.ts](../src/artifacts.ts) | 元数据头与显式附件声明；Discord 将头渲染成 ANSI 代码块 | 元数据和附件解析共享；Markdown、富文本、ANSI、分片与上传由适配器处理 |
| [start.ps1](../start.ps1)、[scripts/supervise.ps1](../scripts/supervise.ps1)、[src/config.ts](../src/config.ts) | 根入口为 PowerShell；监督器按项目路径互斥，主桥按 Discord token 哈希锁定；配置只接收 Discord 用户 ID | 增加平台参数和通用白名单；将所有启动路径纳入同一项目实例锁，不按各平台凭据各自锁定 |

当前已有 `docs/`；[使用说明](usage.md)、[部署说明](deployment.md)、[开发与验证](development.md)仍描述 Discord 实现。本文件是后续开发依据，不提前改写那些说明为已经支持飞书。

## 已对齐的架构决定

### 核心与适配器职责

主控、会话和原生归属、已登记直属 worker、取消回执、任务生命周期、唤醒、模型/强度选择属于桥核心。增加通信平台不另建一套任务管理或缩减这些核心能力。

适配器提供必需通信原语：连接/关闭、授权输入规范化、文本收发、明确回复路由和投递结果。持久收件和去重属于共用可靠性边界；补取历史的分页/游标策略由平台实现。图片和文件是本期交付目标，但格式、大小、权限和后端可消费类型仍受实际限制。

可选能力声明包括原生命令菜单、reaction、消息编辑、交互卡片、Pin、presence。核心通过能力声明调用；缺失时省略展示增强，仍可通过文本命令使用任务管理。无需为每个 Discord UI 缺项强制补另一套界面。

建议扩展现有 `ReplySink` 而非重建框架：

- 输入携带平台、应用/租户、外部消息 ID、发送者、会话类型、接收时间、内容和附件引用；只有通过平台白名单与私聊校验的输入进入核心。
- 回复地址独立于“当前平台”，明确记录平台和会话。发送返回平台消息 ID 及 `delivered` / `failed` / `uncertain` 等投递证据；API 成功不等于用户已经阅读。
- 媒体接口分别负责下载用户消息资源、上传本桥产物、发出资源消息。平台资源 Key 不能当通用本地文件或另一应用的 Key 使用。
- 可选 UI 使用明确的支持声明与限额。按钮触发同一命令/管理动作，并再次校验调用者、会话归属和状态；平台库不得接管桥的会话所有权。

飞书官方 Node SDK 提供 `Client`、`WSClient`；当前官方仓库还提供封装通信与媒体的 `Channel` 模块，可在实现阶段评估。即使使用它，也只作为飞书适配内部工具，不替代桥的 durable ingress、白名单、任务生命周期与回执。[SDK 来源见下表](#官方来源与查证日期)。本轮未安装依赖或运行 SDK。

### 共享命令与状态

现有正常命令共 12 个，已包含 `/help`；无需将它误列为全新命令：

| 命令 | 当前语义与参数示例 |
| --- | --- |
| `/new [codex\|claude]` | 新会话；`new chat`、`新会话`、`新聊天`为文字别名 |
| `/agent [codex\|claude]` | 留空查询；指定后端后优先续接当前目录上下文 |
| `/chats` | 只读列出本人的历史会话，不切换 |
| `/cwd 路径` | 在指定目录新建会话；文本允许处理外层引号 |
| `/model [list\|default\|模型名]` | 查询、列出或选择模型；`/model custom 模型ID` 明确使用自定义 ID |
| `/models` | 列出当前 Agent 模型 |
| `/effort [list\|default\|level]` | 查询或设置推理强度；有效值由后端和模型校验 |
| `/status` | 当前会话、CLI 模型/强度、排队、登记任务状态 |
| `/computers [refresh\|cached]` | 登记电脑与 CLI 入口；默认检查，`cached` 用缓存 |
| `/workers [current\|all]` | 当前对话或本人全部对话的直属 worker 状态 |
| `/stop` | 当前模式下取消桥管理的任务与预约；独立远端进程仍需确认停止 |
| `/help` | 帮助和用法；未知 `/命令` 返回“未知命令；/help 查看可用命令。” |

`/resume` 是停用后的兼容提示，不是可续接命令。模型切换、忙时限制、路径验证、用户白名单、消息去重和原生会话归属继续在核心校验；飞书不依赖 slash UI。命令先解析再交给聊天主控，未知命令不能变成模型执行请求。飞书富文本、提及和附件内容须规范化，保留 `/cwd` 路径、模型 ID 和参数原意。

后续开发将命令定义与帮助集中维护，让两平台 `/help` 同时列出参数、例子、当前模式下的行为及可选 UI。Discord 原生菜单是增强；飞书发送普通字符串 `/help`、`/status` 即可。卡片会话选择属于后续选配，不能把当前 `/chats` 的只读列表变成已经支持任意会话切换。

Discord 的 presence 展示“空闲／运行／排队／重启状态”，飞书本期可完全不实现 presence，也不要求状态卡替代。应用 description 是静态基础信息，名称/图标/描述需要版本发布审核后线上生效，不能高频修改它模拟 presence。本轮未取得机器人动态简介/presence 的可用官方接口证据；不据此断言平台绝对不存在。统一 `/status` 足够承担查询。

运行 worker 数只按**已登记且本轮 running 的 child worker 去重**；不包括 controller、idle 原生会话或 wake。当前 `getGlobalWorkCounts()` 按 running job 的 workerId 去重，排队数按 queued job 计数；`/status` 中“已登记未结束”是另一个口径。后续不能把这两个数字混同，实时运行数应由同一核心状态读取，并保持用户/会话授权过滤。

### 平台选择与单实例启动

根目录拟提供 `DiscordBridgeStart.bat`、`FeishuBridgeStart.bat`，作为方便双击的薄入口；名称可遵循后续项目命名约定。两个入口调用同一启动核心，仅传递平台选择。配置、监督器、优雅停止/重启和运行状态继续共用。

当前没有这些 BAT，也没有平台参数。现状是：

- `start.ps1` 直接启动同一 `dist/src/main.js`。
- `scripts/supervise.ps1` 有项目路径哈希的 supervisor mutex；重复监督器静默退出。它不能覆盖所有直接启动路径。
- `src/main.ts` 有以 Discord token 哈希为身份的命名管道锁；PID 文件是共用 `.local/data/bridge.pid.json`。换平台身份后不能依赖该锁保证共用状态安全。
- 登录启动任务只调用现有监督脚本；另加一个飞书 BAT 不会自动解决自启、重启和手动启动之间的竞争。

需要把跨平台**项目级锁放在共用桥启动路径**，在创建控制器、打开/修改任务状态和建立平台连接前取得。锁身份与 bot token/平台无关，所有 BAT、PowerShell、监督自启、直接主入口均受保护；监督器仍需独立避免重复守护进程。状态记录当前平台、实例、启动阶段，第二次启动明确提示已有运行平台并退出，不自动杀旧桥、覆盖状态或启动第二个控制器。

平台切换须先正常停止旧实例并确认其管理的原生归属已安全处理，再启动新平台。现有退出码 76 表示 owned CLI 未确认停止，监督器不会重试；这条边界不能因换平台而绕过。锁不应限制桥自己派出的 child worker 或远端执行服务。

## 能力映射与官方边界

表中“直接”表示官方原语足够表达该能力，仍需实现并验收；不表示本项目已接通。

| 现有能力/需求 | 飞书落点 | 本期定位 | 权限、限制与证据 |
| --- | --- | --- | --- |
| 私聊文本输入、连续消息、补充 | `im.message.receive_v1` 经官方长连接 SDK进入同一收件队列 | 必需；官方直接支持，未实测接收 | `im:message.p2p_msg:readonly`；机器人启用、事件订阅；筛选 `sender_type=user`、`chat_type=p2p` 及精确 app/租户/白名单。[接收][receive] |
| 回复与长任务完成主动新消息 | 应用身份 `POST /im/v1/messages`，持久保存发起地址 | 必需；主动文本已实测，其余待接入验收 | `im:message:send_as_bot` 或 `im:message`；用户在应用可用范围；同一用户 5 QPS。长期任务用新消息，不依赖交互回调存活。[发送][send] |
| `/命令`、`/help`、`/status`、worker/电脑管理 | 普通文本先进入共享命令路由 | 必需；复用核心，无需飞书原生 slash | 沿用文本收发权限；参数/授权继续核心校验。原生菜单可选，本期不要求实现 |
| 收件 ⏳、完整投递后 ✅，任务数字 reaction | 以平台 `emoji_type` 添加反应，保存 `reaction_id` 后删除自身反应 | 选配；语义映射，未实测 | 当前已有 `im:message` 是增删接口允许的权限之一；表情必须来自官方列表，如 `DONE`，不能照搬任意 Unicode、自定义 Discord 表情或数字计数。[增][react-create]、[删][react-delete]、[表情列表][emojis] |
| 图片贴图/原生表情包 | 图片资源消息；原生 `sticker` 是另一类型 | 选配，区分两种媒介 | `im:resource` 上传普通图片，再用发送权限发图。官方 `sticker` 目前仅能发送机器人收到的表情包 Key；消息资源下载接口不支持表情包。任意自制贴图可作为普通图片，不保证原生 sticker 效果。[消息内容][content]、[资源][resource] |
| 用户图片输入、Agent 图片回传 | 事件取图片 Key；下载消息内资源；上传后发送 image | 本期目标；官方直接支持，未实测 | 下载可用已有 `im:message`，上传 `im:resource`；图片上传≤10 MB，GIF≤2000×2000，其余≤12000×12000；TIFF/HEIC上传会转 JPG。沿用桥支持的 PNG/JPEG/WebP/GIF 与更小本地限额。[图片][image]、[资源][resource] |
| Agent 普通文件回传 | 上传 IM 文件后发送 `file` | 本期目标；官方直接支持，未实测 | `im:resource`＋发送权限；上传非空且≤30 MB；桥当前默认20 MiB、上限24 MiB，迁移初期可保留较小限额。不能用云盘 `file_token` 代替聊天 `file_key`。[文件][file]、[发送][send] |
| 用户普通文件输入 | 事件和消息资源接口下载到本地，再交付可消费后端 | 新能力，不能称现有功能平移 | 官方资源接口支持文件；整件下载<100 MB，大文件需 Range、单片≤32 MB，图片不支持 Range。桥目前输入类型只有文字/本地图片，须新增文件表示与安全处理；不可收到文件就自动执行。[资源][resource]、[现有附件说明](usage.md) |
| 长回复与模型元数据头 | 文本/富文本格式化，按 UTF-8 实际请求大小分片 | 必需输出适配；编辑选配 | 文本请求体≤150 KB，富文本/卡片≤30 KB；Discord当前按2000字符分片，ANSI头不能原样渲染飞书。普通文本编辑最多20次、仅自身消息且期限由企业管理员设置；不默认逐字流式编辑。[发送][send]、[编辑][edit] |
| 取消按钮、会话选择、交互卡片 | 新 `card.action.trigger` 长连接回调，转换成核心授权动作 | 选配；可不实现，未实测 | 发/更卡片可用已有发送权限；还需配置对应回调。3秒内响应；旧卡片回传协议不支持长连接。直接更新卡片仅14天内、同身份、共享卡片配置，单条5 QPS；取消仍先回执再核验实际停止。[回调][callback]、[更新][patch] |
| Pin 消息 | 平台 Pin API | 选配，本期不要求状态面板 | 接口允许 `im:message` 或发送权限等；必须在会话内且消息可见，不能将 Pin 承诺为 presence 等价物。[Pin][pin] |
| Discord动态presence与重启展示 | 飞书可不提供 | 本期不做迁移 | 静态应用 description 保持静态，`/status` 查核心；不频繁发布版本，不强建替代UI |
| 断线补取、去重、可靠通知 | 已知私聊时间范围＋分页历史；核心持久收件/投递日志 | 必需可靠性设计；尚未验收 | 私聊历史可用已有 `im:message`；每页1–50；不读取全部公司会话。接收按 `message_id` 去重，不依赖 `event_id`；发送 `uuid` 可在1小时内去重，但不能替代长期日志。[历史][history]、[接收][receive]、[发送][send] |

上述已有四项权限在官方定义上足以覆盖本期私聊文本、资源和常见反应的基础调用；无需为核心聊天预申请文档、通讯录、人事、OAuth 或撤回等一批工具权限。实际企业策略、可用范围、用户屏蔽/防泄漏设置仍可能阻止调用，不能用权限已勾选替代运行验收。

### 长连接与投递可靠性

[官方长连接文档][ws]最后更新于 2026-06-11，明确：只支持企业自建应用；只需出站访问公网，无需公网 IP、域名或内网穿透；SDK内置传输加密和鉴权。当前 Node 示例要求 SDK ≥1.24.0。

同一 app 最多50个连接，推送采用集群模式，多个客户端中**随机一个**收到事件，不广播。开发时不得另起消费者与正式桥争抢同 app 事件；本期一个 app 对应一个桥消费者。长连接回调需3秒内完成且不抛异常，否则有超时重推：处理器应快速核验、持久化并入队后返回，不能等待 Agent、图片下载或长任务完成。

接收事件文档特别要求按 `message_id` 去重，不要依赖 `event_id`。发送 `uuid` 去重窗口仅1小时；超时、部分附件已发或结果未知时先核对投递，不能盲目重发或重跑 Agent。reaction 失败或限流不改变真实任务状态，也不阻塞主回复；“完成”仍以最终回复及全部附件已投递为条件。

本轮未核实选定 SDK 版本的全部心跳、重连退避、关闭和离线补推窗口保证。实现时固定 SDK 版本并核验这些行为；即使 SDK 自动重连，也不能把它当完整历史重放保证。私聊历史接口支持时间范围和 `page_token`，可构建有界补取，但排序同时间、秒级查询边界与毫秒消息时间、重连竞态仍需去重和验收。

## 身份、会话与平台切换的安全默认

- 内部区分桥用户授权身份与平台地址。消息、聊天、外部用户 ID 按平台/租户/应用命名空间化；飞书 Open ID 属于应用，同一用户在不同应用的 Open ID 不同，不能使用另一 bot 的 ID。
- 默认每个平台账号独立白名单、独立活动会话绑定。本人跨平台关联也必须显式映射并授权；机器人可用范围仅是平台可访问前提，不代替桥白名单或原生会话读取授权。
- 默认结果回送发起入口，不自动同步飞书公司聊天、附件或上下文到 Discord。切换平台不表示授权跨平台续接敏感上下文。若后续提供“在另一入口继续”，应明确展示目标会话和内容范围，经授权后绑定，保持同一原生会话唯一归属。
- 单实例仍共用任务登记和原生归属，不能按平台复制数据库让同一个 worker 被两份桥控制。原生归属、取消确认、交接和不确定状态保持原有规则。
- 现有完成事件只有用户/频道/会话来源，`SessionManager` 直接发给 `event.channelId`；没有平台维度。平台切换后旧任务、wake、未送达附件必须保留原路由，不能把旧 Discord ID 交给飞书发送接口。发起平台未运行时保留待交付状态，明确告知可见状态，不自动转投，也不因换平台重新执行任务。
- 当前桥的优雅关闭可能停止其 owned worker，独立远端进程另有生命周期。首期可在安全退出后切换；“切换后不中断所有在途任务”不是现有保证，需独立定义恢复、取消和回执验收。原退出码76/未确认停止不能绕过。
- 共用状态的数据迁移须有备份、版本与旧 Discord 记录默认命名空间；无需读取或导出全部历史来做本轮调研。白名单、目标电脑原生历史授权也需映射，不能把“第一个Discord白名单用户”规则盲目套给飞书首用户。
- 附件实行尺寸/数量、真实格式、文件名和本地路径校验，保持发起入口路由与清理策略。超限明确反馈，不静默丢弃、越权云盘上传或自动转发另一平台；并发发送按地址串行，遵守平台限流。

## 最小开发阶段与验收

1. **先抽离现有 Discord 耦合**：统一启动平台选择、项目实例锁、配置身份、命令定义、回复路由、收件游标和持久状态版本。复用 `SessionManager`、controller/runtime、任务登记与原生 adapters；保持 Discord 现有行为。
2. **接飞书最小闭环**：官方SDK长连接→授权私聊→持久收件→共享命令/主控→应用身份文本发送。先验 `/help`、`/status`、新会话、取消、连续消息、任务完成主动新消息；不先建设 presence 或卡片系统。
3. **补齐目标媒体与可靠性**：图片输入/回传、现有文件回传、超限错误、分片、重连与重启恢复。用户文件输入作为独立扩展，明确后端处理方式。
4. **选配平台增强**：按真实需求增加 reaction、卡片按钮或菜单；缺失可省略。所有管理动作仍调用核心，不绕过归属和授权。

上线验收至少覆盖：

- Discord/飞书 BAT、PowerShell、直接主入口和自启之间跨平台并发启动互斥；第二实例说明现有平台并退出，不写状态、不连接平台、不新增controller；正常child workers仍能派发。
- 正确 app/租户、本人白名单、p2p类型和用户消息可进入；其他用户、群、机器人自身/其他bot输入不会触发任务。只验授权目标，不扩群或全员范围。
- `/help`列完整命令/参数/例子；所有文本命令与Discord语义一致；未知命令不调用模型，忙时参数限制和取消/切换及时处理。
- registered running child数与真实登记一致；不计controller、idle session或wake；跨用户查询不泄漏任务。
- 一次文本、一次图片、产物图片/文件、超限与资源不可访问明确反馈；所有媒体投递结束才标“完成”。如选配reaction，删除仅自身标记，失败不影响主流程。
- 事件重复、断线重连、回调超时、同时间消息、桥重启、发送超时/部分成功不会重复执行或自动重发；不确定状态有准确回执。
- 长任务结束用新消息主动通知；原生worker续接、取消、交接、完成回执与wake仍遵守核心生命周期。
- 平台切换期间旧任务结果、预约和附件保留来源地址；停用入口结果不会发往另一入口，已授权跨入口续会话也不双占原生session。
- 凭据仅在本地安全配置/进程使用、日志脱敏，SDK生命周期正常关闭；不将应用身份token、用户OAuth或第三方网关身份混用。

本轮只新增调研文档和项目导航，未实现适配器、BAT、平台参数或新锁，未装SDK、启动消费者、运行项目测试、发送消息或修改机器人。接收和媒体等待验证项留给后续明确授权的开发验收。

## 官方来源与查证日期

以下页面于2026-10-14通过官方网页只读核对；通用API支持不等于企业授权。旧URL可能自动重定向至当前文档，内容以实现时的最新页面和固定SDK版本为准。

| 来源 | 本轮核对内容 |
| --- | --- |
| [接收消息][receive]（2026-08-05更新） | 私聊权限、发送者类型、事件版本、message_id去重 |
| [发送消息][send]（2026-04-10更新） | 应用身份、Open ID范围、主动发送、类型、限频、请求大小、uuid窗口 |
| [使用长连接接收事件][ws]（2026-06-11更新） | 出站网络、鉴权、3秒处理、50连接、集群非广播、Node SDK示例 |
| [服务端SDK概述][sdk]、[官方Node SDK仓库][sdk-repo] | tenant凭证生命周期、SDK与Channel入口；未运行或安装 |
| [上传图片][image]、[上传文件][file]、[消息资源下载][resource]（2026-08-27更新） | 媒体格式/大小、Key、资源所属消息、Range与表情包限制 |
| [表情添加][react-create]、[表情删除][react-delete]、[表情文案][emojis] | 可选reaction、身份、reaction_id、自身删除、emoji_type列表 |
| [发送消息内容][content] | 原生sticker只能发送已接收到的表情包Key |
| [编辑消息][edit]、[更新消息卡片][patch] | 普通文本20次/管理员期限、卡片14天/共享配置/限频 |
| [长连接回调][callback]（2026-06-11更新） | 新卡片交互长连接，旧回调不支持，3秒处理 |
| [获取会话历史消息][history]、[Pin消息][pin] | 私聊历史权限、时间/分页；Pin的会话可见性和可选定位 |
| [企业自建应用开发流程][app-flow] | 基础信息变更与版本发布流程；已结合目标应用发布页面验收，动态presence不以description替代 |

[receive]: https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
[send]: https://open.feishu.cn/document/server-docs/im-v1/message/create
[ws]: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
[sdk]: https://open.feishu.cn/document/server-docs/server-side-sdk
[sdk-repo]: https://github.com/larksuite/node-sdk
[image]: https://open.feishu.cn/document/server-docs/im-v1/image/create
[file]: https://open.feishu.cn/document/server-docs/im-v1/file/create
[resource]: https://open.feishu.cn/document/server-docs/im-v1/message/get-2
[react-create]: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
[react-delete]: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
[emojis]: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
[content]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json
[edit]: https://open.feishu.cn/document/server-docs/im-v1/message/update
[patch]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch
[callback]: https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address
[history]: https://open.feishu.cn/document/server-docs/im-v1/message/list
[pin]: https://open.feishu.cn/document/server-docs/im-v1/pin/create
[app-flow]: https://open.feishu.cn/document/develop-process/self-built-application-development-process
