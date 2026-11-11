# 执行助手预设

预设固定电脑、CLI 后端、供应商线路和模型。它扩展现有 `bridge_list_targets` 按需发现接口；普通助手仍通过原参数派发。完整清单不加入初始化和每轮上下文。

## 私有目录

上下文工作区 `bridge-agent-presets/registry.json` 使用 `workspace-template/bridge-agent-presets/example.json` 的格式。每条记录包含稳定 `id`、口语 `aliases`、`targetId`、`agent`、固定 `model`、目标私有 `profileId`、`revision`、`enabled` 和可选停用原因。本机目标为 `local`，远端目标引用现有 `bridge-remote-agents/registry.json`。个人目录在代码仓库外维护，不提交 Git。

预设清单和启动配置统一在上下文工作区维护：`bridge-agent-presets/registry.json`、`bridge-agent-presets/private/profiles.json` 和 `credentials.json`。桥启动后复用已有电脑登记与执行器自动部署，按目标筛选已启用预设，自动准备远端运行资料；离线或忙碌时后续重试，不要求用户逐台复制文件。`profiles.json` 不含密钥：

```json
{
  "version": 1,
  "profiles": [{
    "id": "gateway-sol", "revision": 1, "agent": "codex",
    "model": "gpt-6.1-sol", "baseUrl": "https://gateway.example",
    "credentialId": "gateway-codex", "transport": {"kind": "direct"}
  }]
}
```

远端资料存放在 `<remoteRoot>/.local/bridge-agent-presets/managed/`，由桥维护，模型线路与凭据以同一个文件原子更新。只向对应目标提供其已启用预设需要的资料，不复制整个工作区或预设清单。旧执行器的手工配置保留兼容，旧助手继续使用自己的线路快照。

`profiles.json` 的单个启动配置可选 `targets: {"home": {"transport": {"kind": "ssh-connect", "sshConfig": "目标机已有 SSH 配置绝对路径", "alias": "fixed-alias"}}, "workstation": {"transport": {"kind": "direct"}}}`，集中描述已有目标的线路差异。未覆盖时沿用默认 `transport`；目标 SSH 路径不存在会明确失败，不能把源电脑路径直接当作目标机已就绪。

`credentials.json` 格式为 `{"version":1,"credentials":{"gateway-codex":{"apiKey":"在工作区私有目录填写"}}}`；Claude 支持 `authToken` 或 `apiKey`。限制文件权限，禁止将实际凭据写入目录清单、CLI 参数、主控对话、派工记录、普通发布包或 Git。桥通过已登记的 SSH/SCP 通道向受限私有目录传输所需凭据，传输临时文件在完成或失败后清理；远端无需用户另配预设或安装 CC Switch。

生成器预建 `profiles.json` 和 `credentials.json` 两份空表，不包含真实启动配置或凭据；重复运行保留已有文件。已有 CC Switch 配置可通过 `scripts/import-preset-profiles.mjs` 一次性导入，生成器已创建空文件时使用该脚本现有的 `--replace` 选项填充。构建后，提供**非秘密**导入清单：绝对 `privateRoot`、完整 `profiles` 数组和 `imports:[{"credentialId":"gateway-codex","appType":"codex","providerId":"明确的供应商 ID","dbPath":"目标机数据库绝对路径"}]`。脚本只读明确 ID，不选取当前供应商、不修改物理配置；Windows 先限制目录 ACL。运行 `node scripts/import-preset-profiles.mjs <清单路径>`，更新已有私有资料需追加 `--replace`。启动配置使用清单明确填写的真实入口，不沿用会随 CC Switch 切换而改写请求的代理入口。导入后运行时不再读取 CC Switch。

无法直连的电脑可将 `transport` 改为 `{"kind":"ssh-connect","sshConfig":"本机 SSH 配置绝对路径","alias":"fixed-alias"}`，可选绝对 `sshCommand`。程序为每次 CLI 启动建立 loopback CONNECT，仅允许固定供应商主机和端口，执行固定目的地的 SSH `-L` 本地端口转发，原样转发 TLS；不解密或改写认证、模型和正文。关闭 CLI 时关闭通道及其 SSH 子进程。线路选择由数据决定，不判断机器名。

## 调用与续接

- 主人明确选择预设，或所选电脑的默认助手指向预设时使用。`bridge_list_targets` 一次返回按电脑分组的候选和默认。可用 `query`、`targetId`、`agent` 筛选预设，`includePresets:false` 跳过预设目录；列出目录不连接离线电脑。
- 口语别名帮助理解请求，新 `bridge_start_worker` / `bridge_schedule_worker` 使用 `targetId` 加 `assistant:{kind:"preset",presetId:"稳定ID"}`；旧平铺 `presetId` 兼容。别名引用、历史转述不构成执行授权；存在歧义先澄清。
- 预设固定电脑、后端和模型；显式冲突会拒绝。强度仅接受显式请求和该后端实际支持的值，不继承主控强度。禁用、缺失、线路失败或旧执行器不支持时明确报错，不自动回退。
- 创建或预约时持久化非秘密线路快照。同一预设版本共享一份独立配置，凭据只进入对应子进程环境；不同助手以原生会话 ID 区分，不再各复制一套 CLI home。Codex 继承本机 MCP、插件及工具设置，历史目录与索引连接到普通用户目录；Claude 使用原生用户目录，以进程参数和环境固定预设。CC Switch 切换不会改变预设的模型、网关或密钥。
- worker、预约、续聊及重启恢复沿用同一绑定。之后改目录、别名、当前供应商或新配置不会改动旧助手；更新线路使用新版本，新助手重新查询。凭据可以沿相同引用轮换；删除旧引用会使原助手明确失败。
- 当前补充、下轮续聊、取消和原有派发幂等规则继续有效。收到不完整结果时保存原生会话并标为结果未知，冻结其队列，禁止自动重做；已经确认停止的进程允许桥安全重启，未确认停止的继续阻止重启。
- 目前不提供预设会话的默认 CLI 人工接管命令，避免从用户默认目录恢复到错误供应商。桥内续聊正常；不要手写默认 `codex resume` 接管预设。

主控工具声明有更新。已有 Codex 主控可能需要用户自行 `/new continue` 才能获得新的工具参数；该命令会取消旧预约。Claude 主控重建 MCP 后应以真实工具调用核实新参数已可用。部署不得擅自重置主控或发送测试消息。

## Claude 预设的模型范围

Claude 预设主模型通过 `--model` 指定，同时在进程环境设置 `ANTHROPIC_MODEL`，并将 `ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL` 都固定为该预设模型。Haiku 映射也用于 CLI 的后台辅助功能。另设 `CLAUDE_CODE_SUBAGENT_MODEL` 与 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`，防止内部子助手定义或调用参数另选模型；强制变量要求 Claude Code 2.1.257 或更新版本。新建、续聊和恢复均重新注入相同策略，不依赖用户物理配置。预设进程关闭自动更新，避免运行期间改动共享 CLI 安装。

这是一预设单模型的策略：辅助任务也使用所选模型，选择较贵模型时不保留小模型的费用和延迟优势。废弃的 `ANTHROPIC_SMALL_FAST_MODEL` 只清除、不沿用。它覆盖已知 CLI 模型入口，不是网络层的任意请求拦截；不能据此保证独立脚本直接调用的 API 或网关底层模型。

官方依据：[模型配置](https://code.claude.com/docs/en/model-config#environment-variables)、[强制内部子助手模型](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model)。隔离模拟 API 在 CLI 2.1.301 与 2.1.303 上记录请求模型，覆盖三档遗漏 Fable、默认子助手模型被显式定义覆盖、强制选型生效等分支；不把普通 hello 当作全部后台路径的证明。

## 原生历史可见性

`bridge_start_worker` 与 `bridge_schedule_worker` 支持 `sessionVisibility: "hidden" | "visible"`，默认 `hidden`。两种模式都由 CLI 原生保存：Codex 在对应用户的 `.codex/sessions` 和原生 SQLite 索引，Claude 在 `.claude/projects`。隐藏只影响默认 resume 列表，桥内登记、续聊和恢复不变。用户明确要求原生列表可见时传 `visible`；创建后的可见性绑定不变。

`session-home-root.json` 保留稳定登记编号；用户 `.codex/bridge`、`.claude/bridge` 下只保留少量绑定、共享预设配置和运行时，不再按助手复制历史与缓存。远端执行器在独占 IPC 且任务空闲时自动迁移；离线电脑下次更新时处理。本机桥升级时停止桥后运行 `node scripts/migrate-native-sessions.mjs --offline-apply <数据目录>`。迁移校验正文、原生索引和分页历史数据库，保持会话 ID 和历史字节偏移；目标冲突或未知文件会停下，完整核验后才清理旧 home。原生用户历史不可当作 tmp 清理。

普通助手直接使用目标机普通用户的配置、凭据和历史目录。预设使用独立供应商快照与进程环境，共用原生历史存储，不复制全局认证。

一次性只读助手只清理临时配置，正文与索引仍留在原生目录；退出后将索引中的链接路径转换成实际路径，再移除临时配置。旧版曾自动清掉的只读摘要正文无法补回，迁移保留其现存索引、分页数据和桥内回报，不伪造完整历史。

Claude 旧助手各自的自动记忆保留到原生项目 `memory/bridge-imports/<登记编号>/<类型-助手ID>`，不覆盖或合并用户现用记忆；项目列表缓存另存为同类迁移资料。会话正文仍按原 ID 直接落在原生项目目录。

Codex 助手使用官方独立版 `codex-app-server --session-source app-server|cli`，保留现有 app-server 协议；Claude 使用 `sdk-cli|local-agent` 来源。分别对应隐藏与可见，不用归档冒充隐藏。Windows x64 首次使用自动安装并校验固定版本运行包，也可预先运行 `scripts/install-native-session-runtime.ps1`；仅安装一次，所有助手共用。原生供应商/目录筛选及交接持有权检查不变。

用户从原生列表手动续聊时使用其启动环境和供应商配置；使用桥交接返回的命令则自动加载原助手的独立配置，隐藏会话也可按 ID 续聊。用户退出后，桥接回同一会话并保留原模型、强度、预设快照和显隐状态，可反复交接。桥不修改用户全局配置，不回退普通线路。已有主控若要读取新的参数说明和委派规则，可以按需 `/new continue`，已有助手不需要重建。

## 验证边界

自动化覆盖目录校验、冲突拒绝、认证隔离、线路快照、预约恢复、旧协议拒绝、TLS 原样转发及进程关闭。真实网关冒烟只能确认指定线路接受了相应模型请求和续接；CLI 回报模型名不能独立证明网关底层实际使用的模型。`enabled` 表示用户是否配置启用，不用于记录临时离线状态；桥不会擅自启用明确禁用的预设。已启用的离线目标在下次启动或派工检查时自动准备并重试。程序已更新但预设配置准备失败时记录独立错误状态，不把执行器在线等同于模型可调用；启动静态检查也不冒充真实网关验收。
