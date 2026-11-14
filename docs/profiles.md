# 主控、渠道与旧 Profile

[返回项目首页](../README.md)

当前版本使用 [v4 主控与渠道登记](controller-registry.md)：稳定 controller ID 持有会话、任务和助手，渠道作为可选绑定保存平台身份及收发状态。运行时不再读取项目 `.local/bots/` 或 `startupProfiles`。

- 新部署、网络与可选渠道配置：[主控与渠道登记](controller-registry.md)。
- 已有 v3 部署：[一次性离线迁移](controller-registry.md#旧部署的一次性迁移)。
- 尚未迁到 v3 的更早数据：[历史 v3 迁移资料](legacy-v3-migration.md)。这些旧说明不构成新运行时的兼容或回退路径。
