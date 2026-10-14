# 开发与验证

[返回项目首页](../README.md)

## 开发和验证

安装 Node 24，执行 `npm ci`、`npm test`、`npm run build`。测试使用临时 SQLite、模拟 Agent、模拟 Discord Gateway/HTTP 与飞书 SDK/HTTP；覆盖图片与普通文件回传、原生续聊、取消、重启、重复消息和断线重连。真实机器人上线后，由用户私聊验收。连续消息测试另外覆盖合并窗口、原始 ID 去重、有序图片输入、steer 协议、完成竞态、取消/切换、后端降级和重启/投递失败不重放。受限环境如果测试 runner 无法启动子进程，可用 `node --test --test-isolation=none dist/test/*.test.js` 运行全套；涉及 CLI 子进程的集成测试仍需允许子进程启动的环境。

升级时应在任务结束后由部署方安排停止、备份和重启；本次需完成 [一次性 Profile 语义迁移](profiles.md)，运行版本不加载旧配置或旧 bot 归属。原生会话 ID、去重记录和绑定经迁移保留。仅编译 `dist` 不会让已经运行的桥加载新逻辑，开发验证不要同时启动第二个机器人 worker。

Codex 使用官方 app-server stdio；Claude 使用 CLI stream-json。最高权限沿用用户的授权配置。特殊的 Codex 交互式服务请求当前会明确报错，普通工具执行在最高权限模式下工作。
