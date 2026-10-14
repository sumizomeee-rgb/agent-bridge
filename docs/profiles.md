# Profile、bot 与一次性迁移

桥项目名称为 `agent-bridge`。Discord 和飞书共用会话、主控、执行器、远端调度、任务回执和恢复逻辑；平台适配器负责各自的鉴权、接收、历史、媒体和回复。

## 网络预设

网络配置属于所选 Profile 的 `network.proxyPort`。Discord 示例设置 `7898`，飞书示例设置 `null`（桥直连，不注入专用代理）；缺省也是直连。公共配置不接受旧 `proxyPort` 字段，不会偷偷继承另一个平台的端口。`-ProxyPort` 仅作为本次启动的显式覆盖。Agent 未被 Profile 指定代理时沿用本机自己的默认环境与 CLI 配置。网络改变不影响 bot 身份、会话和任务归属。

## 启动前选择

`Profile` 是“平台 / 本地 bot 预设名”，例如 `discord/default`、`feishu/bot2`。预设名方便人选择，数据归属使用真实的应用身份：`discord:<applicationId>|` 或 `feishu:<applicationId>|`。改预设名或轮换凭据不会丢失该 bot 的会话；不同 bot 的同名用户、频道和消息不会共用绑定。

```powershell
.\start.ps1                         # common config 的 startupProfile
.\start.ps1 -Profile feishu/bot2
.\start.ps1 -Platform feishu         # platformProfiles.feishu
.\start.ps1 -Profile discord/default -Check
.\install-startup.ps1 -Profile discord/default -StartNow
```

`start-discord.bat` 和 `start-feishu.bat` 选择各平台的默认预设。登录启动任务在安装时保存所选 Profile；监督进程及安全重启沿用这个选择。项目锁阻止一个项目并行启动不同平台或 bot，真实 bot 身份锁还阻止同一 bot 被本机另一份桥重复消费。正常停止当前桥后再启动另一预设。聊天指令和主控工具不提供平台、bot 或可选功能切换。

## Git 与本地资料

```text
profiles/discord.example.json        # Git：机器人配置模板
profiles/feishu.example.json         # Git：机器人配置模板
config.example.json                 # Git：公共配置模板，version:2
.local/config.json                  # 私有：CLI、workspace、默认启动预设
.local/bots/discord/default.json     # 私有：applicationId、token、白名单、features
.local/bots/feishu/bot2.json          # 私有：applicationId、appSecret、白名单、features
.local/data/*.sqlite                # 私有：共用数据库，路由身份已按真实 bot 隔离
.local/data/controller-homes/        # 私有：原生主控会话
.local/data/attachments/<Profile>/   # 私有：用户图片
.local/logs/<Profile>/               # 私有：运行日志
.local/backups/                     # 私有：迁移前资料
```

新增 bot 时复制相应模板到本地预设目录，填入该 bot 的真实应用 ID、凭据和明确白名单，再选择它启动。飞书白名单使用该应用下的用户 Open ID；不同应用的 Open ID 不通用。凭据、白名单、实际路径、私聊记录、运行数据和认证副本均不提交 Git；模板、格式校验、启动代码和使用说明提交 Git。

Discord 可选 `reactions`、`nativeCommands`、`presence`；飞书支持可选收件和送达表情回执，不支持后两项。两端都在持久收件后标记处理中、最终回复送达后标记完成；Discord 使用 ⏳／✅，飞书使用原生 Typing／DONE。飞书应用需有表情回复读写权限；重启后仅清理当前 bot 自己的处理中表情。`features` 在启动时加载，改动后须重启。飞书用文字 `/status` 查询状态。

## 现有部署的离线语义迁移

运行版本只接受 version:2 配置和数据，不保留旧配置自动加载、旧目录别名或旧路由归属回退。迁移程序是部署时的一次性工具。

1. 用当前部署的停止脚本停用监督进程，确认主控和子进程都结束；停止旧登录启动任务。
2. 构建新代码，使用项目 Node 运行：

```powershell
& .\.local\runtime\win-x64\node.exe .\dist\src\profile-cli.js migrate 'C:\SuchProject\Other\agent-bridge'
```

3. 工具先通过原 Discord 凭据验证真实应用身份，拒绝运行中的桥；复制 SQLite（含 WAL 中的已提交记录）到暂存区，迁移并检查完整性。准备成功后替换资料；普通异常会还原已替换文件。迁移清单和原件保存在私有备份目录。
4. 用户、频道和消息归属增加真实 bot 命名空间；原生会话 ID、内部任务/派发编号、消息正文、模型/强度选择和回执签名材料保持不变。项目内部的结构化绝对路径及 Codex 主控索引中的会话文件路径同步更新，外部工作区路径保留。
5. 按输出清单保存备份后，把部署目录改为新名称，更新 Git remote、工作区导航和登录启动任务。注册表里若显式配置了原生历史访问白名单，改为相应命名空间用户 ID。
6. 已登记远端执行器也要在空闲并停止后迁移归属、更新构建。使用新版本工具：

```powershell
& <Node> <新构建>\dist\src\profile-cli.js migrate-remote '<远端执行器运行目录>' '<已验证的Discord应用ID>'
```

远端迁移保留原生会话和派发编号，更新已保存请求及会话租约中的用户归属。迁移后执行器仍通过原登记连接、目标用户原有 CLI 和认证工作。执行中的任务必须先结束或停止；不把未知任务重新派发来“补验收”。

新 bot 不会接收旧 bot 的任务结果。未启用来源的记录和回执留在原入口；再次启动原 bot 才继续它的恢复流程。不自动合并不同平台的本人账号或会话。

## 飞书能力边界

使用企业自建机器人与官方 Node SDK 长连接，仅发出连接，不需要公网回调地址。白名单 p2p 用户消息先写持久收件箱再确认，核心负责去重和命令解析；历史补取使用时间与分页 token，包含同一时间的多个不透明消息 ID。鉴权 Token 在内存缓存，密钥来自本地 Profile。

支持文字、富文本中的文字/图片、用户图片输入，以及 Agent 图片和普通文件回传。用户普通文件输入暂未启用，会明确反馈。每轮最多 10 个附件、总量最多 100 MiB；飞书单张图片最多 10 MiB，普通回传文件还受公共 maxFileBytes 限制。按真实图片字节检查类型，下载超限或部分失败会清理本轮临时图片。

文字按 UTF-8 字节分片，同一频道串行发送。最终确认前的部分成功或网络错误保留投递未知状态，不自动重发消息、不重新运行 Agent；完成反应在全部回复成功后尝试，失败不改变任务结果。飞书群、他人和机器人自身消息不会启动执行。

harucode 的文档网关只作为既有实现参考，本项目不接入它，不依赖公司内网。执行 Agent 的文档工具来自该电脑已有技能或后续独立登记的能力；通信平台选择不自动授予文档权限。
