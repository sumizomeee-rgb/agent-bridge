# 开发与验证

[返回项目首页](../README.md)

## 开发和验证

安装 Node 24，执行 `npm ci`、`npm test`、`npm run build`。测试使用临时 SQLite、模拟 Agent、模拟 Discord Gateway/HTTP 与飞书 SDK/HTTP；覆盖图片与普通文件回传、原生续聊、取消、重启、重复消息和断线重连。离线测试不能替代真实平台和模型验收；群聊与多 Bot 的统一设计、A01–A31 及发布门槛见 [群主控设计](group-controller-design.md#13-本轮实施与验收边界2026-10-17)。连续消息测试另外覆盖合并窗口、原始 ID 去重、有序图片输入、steer 协议、完成竞态、取消/切换、后端降级和重启/投递失败不重放。受限环境如果测试 runner 无法启动子进程，可用 `node --test --test-isolation=none dist/test/*.test.js` 运行全套；涉及 CLI 子进程的集成测试仍需允许子进程启动的环境。

升级时应在任务结束后由部署方安排停止、备份和重启；本次需完成 [v3 宿主一次性语义迁移](profiles.md)，运行版本只接受显式启动集合和 Bot 归属。更早的 Profile 迁移只是前序工具，不能代替 v2 → v3 宿主迁移。原生会话 ID、去重记录和绑定经迁移保留。仅编译 `dist` 不会让已经运行的桥加载新逻辑，开发验证不要同时启动第二个机器人 worker。

大规模回归可以先 `npm run build`，再用 `node --test --test-concurrency=1 --test-timeout=90000 dist/test/*.test.js` 串行运行；期间不要覆盖 `dist`。测试中注册的资源、进程和临时目录必须在结束后关闭，失败的停止不能通过清数据库状态伪造成功。

正常完成后的 CLI 进程退出与继承管道关闭分别验证：后台程序仍持有 stdout/stderr 时，桥停止协议解析并继续排空管道，不据此误报 CLI 仍运行，也不为关闭管道强杀业务后台。显式取消仍须确认受控 CLI 树停止，不能用根进程退出或 kill 调用返回值冒充。回归必须包含真实 Windows 启动器、继承输出且持续写日志的后台、迟到退出、取消升级及重启后的逐 job 退出核对；仅 mock stop() 抛错不能证明这些边界。

Codex 使用官方 app-server stdio；Claude 使用 CLI stream-json。最高权限沿用用户的授权配置。特殊的 Codex 交互式服务请求当前会明确报错，普通工具执行在最高权限模式下工作。
