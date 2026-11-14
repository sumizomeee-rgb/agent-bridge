# 主控与渠道登记（v4）

[项目首页](../README.md) · [部署](deployment.md)

主控以稳定 controller ID 保存身份、会话、助手、任务和定时。思考后端与聊天渠道分别登记：后端可以是原生 Codex / Claude，也可以是 external Agent；channel 绑定可省略。Bot 的真实平台应用 ID、白名单、收发和附件属于渠道。更换思考后端不改变主控 ID，也不凭昵称推断操作者。

## 配置入口与目录

项目 `.local/config.json` 只保存 `version:4`、`workspaceRoot`、CLI 命令和公共运行选项。工作区路径明确指定；相对路径以该配置文件所在目录解析。其余登记放在工作区：

```text
bridge-registry/
  config.json
  controllers/<controllerId>/config.json
  controllers/<controllerId>/data/
  channels/lark|discord/README.md
  channels/lark|discord/bots/<applicationId>/config.json
  channels/lark|discord/bots/<applicationId>/credentials.json
  channels/lark|discord/bots/<applicationId>/data/
bridge-computers/
bridge-local/host/
bridge-local/browser/
```

真实登记、凭据和运行数据不进入源码 Git。骨架只含空登记、说明和示例。工作区 README 仍是主控固定初始化的唯一入口；本页只供部署、接入时按需查阅。

登记索引示例（真实 ID 需替换）：

```json
{
  "version": 4,
  "startupControllers": ["teto", "research"],
  "controllers": ["teto", "research"],
  "channels": ["feishu:cli_example"],
  "principals": [{"id":"owner","accounts":{"feishu:cli_example":"ou_example"}}],
  "spaces": []
}
```

`controllers` / `channels` 是已登记清单，`startupControllers` 是本次启动集合；未启动的渠道和主控登记仍保留。无渠道主控也可加入启动集合。`principals` 显式映射各平台应用下的同一个用户；`spaces` 以渠道 ID 映射真实工作群。不同飞书应用的用户 open ID 和群地址不能互换。

## 主控与渠道配置

`controllers/teto/config.json`：

```json
{
  "version": 1,
  "id": "teto",
  "aliases": ["Teto"],
  "ownerPrincipalId": "owner",
  "backend": {"kind":"native","agent":"codex"},
  "channelId": "feishu:cli_example",
  "network": {"proxyPort":7898},
  "wait": {"responseMs":null}
}
```

原生 `agent` 可为 `codex` 或 `claude`；主控预设仍由正常 `/model preset` 选择，固定供应商配置与普通 CLI 设置独立。`workspace` 默认等于 bootstrap 指定工作区，`workingCwd` 默认等于该主控工作区；可显式覆盖，不再按平台或应用 ID 派生目录。业务 owner 使用 `principal:<ownerPrincipalId>`，真实平台来源继续保留原用户、消息和群地址。

`channels/lark/bots/cli_example/config.json`：

```json
{
  "version": 1,
  "id": "feishu:cli_example",
  "profile": "feishu/main",
  "platform": "feishu",
  "applicationId": "cli_example",
  "allowedUserIds": ["ou_example"],
  "network": {"proxyPort":null},
  "features": {"reactions":true}
}
```

同目录 `credentials.json` 为 `{"version":1,"appSecret":"填写真实凭据"}`。Discord 的目录是 `discord/bots/<应用ID>`，`id` 为 `discord:<应用ID>`，凭据字段为 `token`，白名单为真实用户 ID。`profile` 是启动脚本可接受的可读登记名，不拥有主控状态。渠道不能夹带 backend、workspace、defaultAgent 或主控别名。

渠道网络用于平台连接，主控网络用于思考后端，彼此独立。平台权限、附件上限和命令行为仍沿用对应平台实现；登记成功不代表鉴权或网络已通过现场验收。

## 无渠道的外部 Agent

`controllers/research/config.json` 示例：

```json
{
  "version": 1,
  "id": "research",
  "aliases": ["Research"],
  "ownerPrincipalId": "owner",
  "backend": {"kind":"external","endpointId":"research-agent"},
  "wait": {"responseMs":null}
}
```

省略 `channelId`。外部 Agent 使用同一套主控工具、助手调度、回执和结束轮次校验，不直接变成聊天平台，也不绕过桥的工具执行入口。

宿主启动就绪后，在 `bridge-local/host/external-api.json` 写入本机动态监听地址、各主控 URL 与 scoped bearer token；每个主控的持久 token 另存于 `external-api/<controllerId>.json`。这些都是私有凭据文件，不复制到公开文档或聊天内容。服务只监听 `127.0.0.1`，请求先验证对应主控的 token，再解析正文；JSON 正文上限 64 KiB。正常关闭移除就绪 manifest，重启后重新读取当前端口，不能把磁盘旧端口当作存活证明。

以下路径均接在 manifest 中该主控 URL 后。除 events/status 外均为 POST，头部为 `Authorization: Bearer <该主控token>`：

| 路径 | 参数与作用 |
| --- | --- |
| `/connect` | `instanceId, sessionId`；登记真实外部实例和会话，取得 lease。同一真实 Session 可由新实例接回并替换旧 lease，旧实例不能继续写入；真实 Session 变化必须显式 handoff，不可直接覆盖。 |
| `/input` | `requestId, text`；仅无渠道主控接受新的外部输入，来源和 owner 由宿主固定，调用者不能传 userId/channelId。 |
| `GET /status` | 已认证的本主控 binding（含 lease）、持久决策简表与 eventSequence；可带 requestId 查输入账本，或 decisionId + callId 查原工具结果。不会返回 API bearer token。 |
| `/handoff` | `lease, previousSessionId, instanceId, sessionId`；明确换到新的真实外部 Session，创建新的桥 conversation，稳定 controller ID 不变；迁移原助手、任务、计划、待处理事件与排队输入。 |
| `GET /events?lease=…&after=N` | 增量读取持久事件，使用 sequence 游标；decision 事件含本轮输入、固定上下文与来源。 |
| `/accept` | `lease, decisionId`；明确接收当前决策。 |
| `/call` | `lease, decisionId, callId, name, args`；调用主控工具，沿用统一协调和权限校验。 |
| `/finish` | `lease, decisionId`；显式请求结束当前决策，由共同协调器验证是否完成；需要补充决策时继续消费新事件。 |

`input` 的 accepted 只表示桥已接收输入，不等于 Agent 完成回复。`requestId` 持久去重：相同正文重复提交不会再次派送，异参冲突被拒绝；提交结果 unknown 用 status 核对，不能更换 ID 盲目重发；当宿主已持久保存对应输入时，查询可确认 accepted。工具 `callId` 同样保留既有调用记录和未知结果，不自动重做副作用。绑定了聊天渠道的外部主控可从 API 消费决策和调用工具，但新用户消息从已绑定的真实渠道进入。

外部等待可跨正常重启：决策、事件、lease 和协调状态保存在主控 data；重连后按当前 lease、事件游标和 decisionId 继续。`wait.responseMs:null` 不设响应期限，正整数配置响应期限；原 deadline 跨重启保留，不重新计时。到期只结束该等待，不把已派助手当作停止。停止、新建会话、会话替换或期限到达会使旧决策失效；旧 lease / decision 不能继续操作。外部 Agent 必须显式 finish，连接成功、读过事件或工具返回均不自动代表完成。

交接仅在没有在途工具调用时进行；旧 lease 与旧 Session 必须匹配。交接意图和跨库提交 journal 持久保留，重启先按原日志幂等完成绑定与任务转移，不重新生成同一交接的会话。旧决策及 callId 账本可追溯，新真实 Session 不冒充旧 Session；仅云电脑/PID 或运行实例改变而真实 Session 不变时，使用 connect 接回即可。

## 旧部署的一次性迁移

新运行时只读取 v4 登记。已有 v3 数据先在旧版本中排空任务、正常停桥并确认子进程停止，再更新程序并执行迁移；新 start/stop 脚本已使用新宿主目录，不能拿它们停止尚在旧目录运行的进程。更早版本先参考 [历史 v3 迁移资料](legacy-v3-migration.md)。

```powershell
node dist/src/registry-migration-cli.js --config 'D:\AgentBridge\.local\config.json' --workspace 'D:\Agent Workspace'
node dist/src/registry-migration-cli.js --config 'D:\AgentBridge\.local\config.json' --workspace 'D:\Agent Workspace' --controller 'feishu:cli_example=teto' --apply
```

默认只预览，不写配置和运行数据。可用 `--controller <渠道ID>=<稳定主控ID>` 明确映射；owner 无法从登记确认时，用 `--owner <渠道ID>=<原平台用户ID>` 指定并校验。预览出现 blockers 先核对，不伪造停止标记或改任务状态强行迁移。

apply 在 staging 中复制并核验数据库、目录、主控归属和新登记，再切换 bootstrap。ingress/outbox/生命周期/附件拆给渠道，其余会话、任务、计划、恢复和票据保留给主控；业务 owner 转成 principal，原消息 ID、群地址和来源身份保留。程序保存的绝对运行路径一次更新；原生历史联接只重建联接，不复制整份用户历史。

迁移不自动生成备份，也不删除旧材料；成功清单记录在新宿主 `registry-migration.json`。失败保留 staging 和错误证据，并恢复 bootstrap；核实新桥的会话、任务、计划和平台体验后，再将确认不用的旧材料移入回收站。不要把尚未验收的源目录当垃圾提前清除。

执行器用户目录中的消息库另按 scope-version 进行一次性迁移：归属由旧用户 scope 改为 controllerId 与用户的组合，防止同一 owner 的不同主控串线。已认证的新目录依据旧 recipient 的 Bot 身份和 principal 明确匹配，迁移旧 bindings、待投递消息与发送者记录后才启用新 schema；远端离线时保留原库，首次重新登记后完成。映射缺失或冲突会保留数据并报告待处理，不猜默认主控，也不持续读取旧归属。

若旧本地任务仍为 uncertain，可在逐项核实宿主开机时间后给迁移 CLI 传 `--host-boot-at <ISO时间>`：仅接受最后一次任务更新及启动均早于该开机时间、已明确属于本机的旧任务，以证明旧进程不可能存活。任务仍保留待核对状态，证明进入迁移清单；桥机开机时间不能证明远端执行已经停止。没有旧 recipient 的执行器，须由已认证的 `owners/migrate` 登记明确的 controller / Bot / principal / 旧用户 / 新用户映射后迁移；不从昵称或默认主控猜归属。
