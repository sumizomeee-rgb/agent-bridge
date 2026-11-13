# 执行助手与主控通信

本目录由桥维护，`tmp/` 用于任务临时产物，可在不用时清理。其他文件为程序、说明与注册配置，不在其中放任务产物。会话历史和通信数据存于当前用户目录，不在这里累积。

用户在原生 Codex / Claude 会话中接手续聊后，仍可要求助手把相关内容发给所属主控：讨论、交付、求助或其他需求都使用同一个自由文本入口。仅发送与用户要求相关的正文，不自动上传完整聊天或无关文件。

在执行器根目录使用 PowerShell 7 执行 `scripts/message-controller.ps1`。桥本机使用项目根目录的同名脚本，本文位于其 `executor/` 子目录。首次派工导航会给出本助手 ID。若忘记 ID，先 `list` 对照引擎、原生会话 ID、标题和目录选择；多个候选不能只凭相同目录猜选。

```powershell
& ./scripts/message-controller.ps1 list
& ./scripts/message-controller.ps1 controllers
$messageId = [guid]::NewGuid().ToString()
& ./scripts/message-controller.ps1 send --worker '<助手 ID>' --id $messageId --text '把刚刚对齐的结论交给主控，请判断下一步……'
# 明确点名其他主控：--to 使用 controllers 返回的名称、别名或 botId，不写死具体 Bot。
& ./scripts/message-controller.ps1 send --worker '<助手 ID>' --to '<主控名称或 botId>' --id ([guid]::NewGuid().ToString()) --text '请这位主控判断……'
# 用户自己新开的普通 CLI 也可直接指定主控，无须先成为桥助手。
& ./scripts/message-controller.ps1 send --to '<主控名称或 botId>' --id ([guid]::NewGuid().ToString()) --text '我们刚刚的对齐是……'
# 长正文也可用 --file '<UTF-8 文本绝对路径>'，与 --text 二选一。
& ./scripts/message-controller.ps1 get --id $messageId
```

`queued` 表示已本地落盘、等待桥接收，不代表主控已看见。`accepted` 表示桥已接收、等待主控处理。`handled` 表示已处理，`reply` 是主控给原助手的答复，可能为空；`uncertain` 表示处理结果未知，先核对，不自动重发。桥或网络离线时队列保留。使用原消息 ID 查询或重试，不为同一条消息新建 ID。

消息跟随所属 Bot 的当前主控，跨 `/new`、重启保留。主控可以回复助手、派工或按需通知用户；内部答复不会自动重复发到聊天软件。命令不会抢占或自动续接用户正在操作的 CLI 会话，助手按需执行 `get` 取回答复。

不填 `--to` 时默认找已登记助手的所属主控；明确点名时从当前桥动态同步的已激活主控目录解析，投递给该 Bot 的当前会话，不改变原助手归属。同名主控或跨平台重名须使用目录里的完整 botId，不自动选第一个；目录是最近同步的快照，不保证此刻在线。目标改名、激活或停用后随目录刷新。跨主控仅限同一负责人的登记；普通 CLI 直接点名时仍需使用本机已登记的主控，不自行拼接网络地址。
