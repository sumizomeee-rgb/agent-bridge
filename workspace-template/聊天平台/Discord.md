# Discord 聊天平台能力

本文件说明 Discord Bot 的操作入口和选路方法。能力范围取决于当前应用、服务器／频道权限、Gateway intents 和真实工具入口；不保存 Bot Token、个人认证或实时在线状态。

## 初始化只读范围

仅当桥提供的当前平台为 `discord`，且工作区 README 将本文件列为初始化入口时读取。提炼能力入口、适用场景、核对方式和未知项给主控，不加载飞书文档，不联网检查或执行消息、成员管理等操作。平台未知时如实报告。

## 方法选择

| 需求 | 优先考虑的入口 | 实际执行前核对 |
| --- | --- | --- |
| 确认 Bot 与应用身份 | Discord Bot／应用信息接口 | 稳定 applicationId 和 Bot ID；显示名只用于展示 |
| 查询允许访问的频道、话题及消息 | Discord REST API | guild、channel／thread 的真实 ID、频道权限及内容可见范围 |
| 已授权的消息和附件交付 | 已有桥消息出口或 Discord REST API | 固定目标、Bot 身份、附件限制、返回消息 ID 与回读 |
| 接收群事件和处理斜杠命令 | 已部署的 Gateway 与应用命令适配器 | 实际 intents、事件过滤、命令场所及负责人鉴权 |
| 接口不适用的个人页面操作 | 已登记的 Discord 网页／桌面入口 | 用户登录会话和实际操作能力；不把 Bot 认证当个人登录 |

接口能够满足已授权需求并可核对结果时，优先考虑已有接口入口，再按任务权衡网页或桌面。不要为了列在文档中的功能自动修改权限、注册命令或扩大 Bot 的监听范围。

## 身份与执行入口

- 真实身份使用 `discord:<applicationId>`，显示名和用户别名只用于检索。凭据位于对应部署 `.local/bots/discord/<固定标识>.json`，不放入文档、初始化摘要、记忆或聊天。
- 只使用实际登记并授权的应用与频道；一个服务器不等于一个对话现场。回复固定回原频道／话题，不能改投最近活跃地址。
- 主控按已开放的工具执行，或委派已登记执行 Agent；本文件不会新增工具或开放服务器群聊功能。私聊接口验收不能替代服务器频道验收。
- 真实提及、机器人之间的事件可见性、Message Content 和应用命令场所须分别核对。不从模型生成的文字中推断真实提及，不意外触发 @everyone 或无关成员。

## 就绪与结果

能力登记区分静态前提、历史验收及当前操作结果。发送结果未知时先查证，不重复发送；通过返回消息 ID、目标频道和内容／附件核对交付。平台 API 可用不等于桥已支持多 Bot 自主协作。

官方参考：[消息接口](https://docs.discord.com/developers/resources/message)、[应用命令](https://docs.discord.com/developers/interactions/application-commands)、[Gateway](https://docs.discord.com/developers/events/gateway)。具体权限与参数以任务时的官方文档和真实结果为准。
