# 命令、消息展示和生命周期

`src/commands.ts` 是两个平台共用的命令定义，包含参数、说明和用法。Discord 的原生菜单由它生成；飞书输入同名文字命令，进入同一个 SessionManager。`/help` 也由此生成。平台和 bot 只能在启动前通过 Profile 选择。

`/status` 只查询状态，不创建会话或调用模型。没有会话时也显示平台、机器人、Profile、模式、默认 Agent、目录和排队数量；模型选择与 CLI 实际回报分开，未回报不伪装为已生效。第一次发送普通文字或图片会自动新建该 bot 下的独立会话。

核心使用 `BridgePresentation` 描述标题、语义色、正文或条目及说明；不生成 ANSI 或平台卡片 JSON。Discord 渲染器保留绿色回复头、黄色电脑／助手总览。飞书使用 JSON 2.0 卡片，回复头和就绪通知为绿色，状态与帮助为蓝色，总览为橙色；正文支持 Markdown 和代码块，长回复分页重复标题，条目和元数据按文字展示，不触发提及。图片、文件仍作为附件按顺序发送。

`BridgeLifecycleEvent` 描述 draining、recovering、ready、failed。ready 只在平台连接、会话恢复及服务初始化完成后发布一次；长连接重连不触发它。Discord 通过在线状态呈现，继续显示“已重启”及汇总数量。飞书在 ready 时向当前实际 bot 最近收到消息的一个白名单用户发送就绪卡片，已有会话保留；找不到联系人则不发送，不广播，也不跨 bot 借用联系人。

生命周期投递在 `.local/data/lifecycle.sqlite` 中记录。发送前记 attempted，成功记 delivered，失败或结果不确定记 uncertain；同一进程不会重复尝试，重连也不补发。通知失败不阻止桥继续处理消息。启动成功只代表连接与恢复完成，不代表模型提供方已通过实测。

飞书结构参照[卡片 JSON 2.0](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)及[Markdown 组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text)。
