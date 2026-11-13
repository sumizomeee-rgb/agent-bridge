# 执行助手与主控通信

本目录由桥维护，`tmp/` 用于任务临时产物，可在不用时清理。其他文件为程序、说明与注册配置，不在其中放任务产物。会话历史和通信数据存于当前用户目录，不在这里累积。

用户在原生 Codex / Claude 会话中接手续聊后，仍可要求助手把相关内容发给所属主控：讨论、交付、求助或其他需求都使用同一个自由文本入口。仅发送与用户要求相关的正文，不自动上传完整聊天或无关文件。

在执行器根目录使用 PowerShell 7 执行 `scripts/message-controller.ps1`。桥本机使用项目根目录的同名脚本，本文位于其 `executor/` 子目录。首次派工导航会给出本助手 ID。若忘记 ID，先 `list` 对照引擎、原生会话 ID、标题和目录选择；多个候选不能只凭相同目录猜选。

```powershell
& ./scripts/message-controller.ps1 list
$messageId = [guid]::NewGuid().ToString()
& ./scripts/message-controller.ps1 send --worker '<助手 ID>' --id $messageId --text '把刚刚对齐的结论交给主控，请判断下一步……'
# 长正文也可用 --file '<UTF-8 文本绝对路径>'，与 --text 二选一。
& ./scripts/message-controller.ps1 get --id $messageId
```

`queued` 表示已本地落盘、等待桥接收，不代表主控已看见。`accepted` 表示桥已接收、等待主控处理。`handled` 表示已处理，`reply` 是主控给原助手的答复，可能为空；`uncertain` 表示处理结果未知，先核对，不自动重发。桥或网络离线时队列保留。使用原消息 ID 查询或重试，不为同一条消息新建 ID。

消息跟随所属 Bot 的当前主控，跨 `/new`、重启保留。主控可以回复助手、派工或按需通知用户；内部答复不会自动重复发到聊天软件。命令不会抢占或自动续接用户正在操作的 CLI 会话，助手按需执行 `get` 取回答复。
