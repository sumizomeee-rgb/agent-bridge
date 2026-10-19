# 执行助手预设

预设固定电脑、CLI 后端、供应商线路和模型。它扩展现有 `bridge_list_targets` 按需发现接口；普通助手仍通过原参数派发。完整清单不加入初始化和每轮上下文。

## 私有目录

上下文工作区 `agent-presets/registry.json` 使用 `workspace-template/agent-presets/example.json` 的格式。每条记录包含稳定 `id`、口语 `aliases`、`targetId`、`agent`、固定 `model`、目标私有 `profileId`、`revision`、`enabled` 和可选停用原因。本机目标为 `local`，远端目标引用现有 `remote-agents/registry.json`。个人目录在代码仓库外维护，不提交 Git。

执行电脑持有两份独立私有文件：本机执行放 `<contextWorkspace>/agent-presets/private/`，远端执行放 `<remoteRoot>/.local/agent-presets/`。`profiles.json` 不含密钥：

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

`credentials.json` 格式为 `{"version":1,"credentials":{"gateway-codex":{"apiKey":"由目标机私下填写"}}}`；Claude 支持 `authToken` 或 `apiKey`。限制文件权限，禁止将实际凭据写入目录清单、CLI 参数、主控对话、远端派发或 Git。目标机直接维护这些文件即可，无需安装 CC Switch。

已有 CC Switch 配置可通过 `scripts/import-preset-profiles.mjs` 一次性导入。构建后，提供**非秘密**导入清单：绝对 `privateRoot`、完整 `profiles` 数组和 `imports:[{"credentialId":"gateway-codex","appType":"codex","providerId":"明确的供应商 ID","dbPath":"目标机数据库绝对路径"}]`。脚本只读明确 ID，不选取当前供应商、不修改物理配置；Windows 先限制目录 ACL。运行 `node scripts/import-preset-profiles.mjs <清单路径>`，更新已有私有资料需追加 `--replace`。启动配置使用清单明确填写的真实入口，不沿用会随 CC Switch 切换而改写请求的代理入口。导入后运行时不再读取 CC Switch。

无法直连的电脑可将 `transport` 改为 `{"kind":"ssh-connect","sshConfig":"本机 SSH 配置绝对路径","alias":"fixed-alias"}`，可选绝对 `sshCommand`。程序为每次 CLI 启动建立 loopback CONNECT，仅允许固定供应商主机和端口，执行固定目的地的 SSH `-L` 本地端口转发，原样转发 TLS；不解密或改写认证、模型和正文。关闭 CLI 时关闭通道及其 SSH 子进程。线路选择由数据决定，不判断机器名。

## 调用与续接

- 主人明确要求某预设时，先用 `bridge_list_targets` 查询。可用 `query`、`targetId`、`agent` 筛选预设，`includePresets:false` 跳过预设目录；列出目录不连接离线电脑。
- 口语别名帮助理解请求，实际 `bridge_start_worker` / `bridge_schedule_worker` 传稳定 `presetId`。别名引用、历史转述不构成执行授权；存在歧义先澄清。
- 预设固定电脑、后端和模型；显式冲突会拒绝。强度仅接受显式请求和该后端实际支持的值，不继承主控强度。禁用、缺失、线路失败或旧执行器不支持时明确报错，不自动回退。
- 创建或预约时，在执行机持久化非秘密线路快照。每个助手拥有独立 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`，不复制全局 settings、auth 或供应商配置；允许链接用户技能目录。只为该进程构造完整配置，屏蔽冲突认证和代理环境变量。不要清理这些目录，否则原生续聊会被拒绝。
- worker、预约、续聊及重启恢复沿用同一绑定。之后改目录、别名、当前供应商或新配置不会改动旧助手；更新线路使用新版本，新助手重新查询。凭据可以沿相同引用轮换；删除旧引用会使原助手明确失败。
- 当前补充、下轮续聊、取消和原有派发幂等规则继续有效。收到不完整结果时保存原生会话并标为结果未知，冻结其队列，禁止自动重做；已经确认停止的进程允许桥安全重启，未确认停止的继续阻止重启。
- 目前不提供预设会话的默认 CLI 人工接管命令，避免从用户默认目录恢复到错误供应商。桥内续聊正常；不要手写默认 `codex resume` 接管预设。

主控工具声明有更新。已有 Codex 主控可能需要用户自行 `/new continue` 才能获得新的工具参数；该命令会取消旧预约。Claude 主控重建 MCP 后应以真实工具调用核实新参数已可用。部署不得擅自重置主控或发送测试消息。

## 验证边界

自动化覆盖目录校验、冲突拒绝、认证隔离、线路快照、预约恢复、旧协议拒绝、TLS 原样转发及进程关闭。真实网关冒烟只能确认指定线路接受了相应模型请求和续接；CLI 回报模型名不能独立证明网关底层实际使用的模型。离线电脑须保持停用，待上线后另行验收。
