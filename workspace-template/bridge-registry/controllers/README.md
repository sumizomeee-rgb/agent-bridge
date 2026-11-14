# 主控登记

每个主控以稳定英文 ID 建目录，`config.json` 保存身份、思考后端和可选渠道引用；`data/` 为桥维护的历史、任务和会话数据。真实主控在上级 `config.json` 登记；配置与运行数据不提交 Git。

`config.example.json` 是说明模板，初始化不会据此创建主控。工作区缺省使用初始化指定的根目录，只有明确覆盖时才配置 workspace / workingCwd。主控网络独立于聊天渠道网络。
