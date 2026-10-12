# 能力登记与就绪检查

[返回项目首页](../README.md)

工作区的 `capabilities.json` 保存能力入口和验收记录，桥的 `.local/data/capability-health` 保存当前检查缓存。登记属于用户上下文；检查和任务观测由桥提供。启动、重启做轻检查，主控按需调用 `bridge_check_capabilities`；新会话仍只初始化 `AGENTS.md`、`README.md`，不会为初始化远连或探测业务页面，也不逐轮注入完整报告。

## 登记

生成器提供有效空表和独立的 `capabilities.example.json`，示例不会自动启用。填入真实值后放到实际表；不存密码、Token、Cookie 或截图。远端 `targetId` 对应同目录 `agents.json`，本机使用保留值 `local`。

| 字段 | 内容 |
| --- | --- |
| `id`、`label`、`targetId` | 稳定能力编号、说明和执行电脑 |
| `agent` | 可选 `codex` 或 `claude` |
| `kind` | `cli`、`browser`、`web-app` 或 `desktop` |
| `browser` | 浏览器 profile 绝对路径、真实扩展 ID、可选本地原生宿主清单路径 |
| `acceptance` | 最近一次验收时间 `checkedAt`、`passed`／`failed`、验收范围 `scope` 及简短说明 `note` |

验收范围使用 `cli`、`dom`、`file-selection`、`app-read`、`app-write`、`file-delivery`、`desktop`。分别登记和验收网页读取、文件选择及业务交付；独立空浏览器不代表接管了常用 Chrome，选择成功不代表已发送图片，网页接口通过也不代表锁屏桌面可操作。

## 检查和使用

检查报告的 `scope` 为 `static-prerequisites`：本机检查已配置 CLI、浏览器 profile、扩展权限及原生宿主等前提；远端只核对登记，不自动 SSH。`ready` 仅表示已检查的静态前提齐全，运行状态仍是 `unknown`，网站登录、实时连接和实际交付由执行 Agent 在相关任务中确认。历史 `acceptance` 与当前状态分开展示，历史通过不能当作永久就绪。

`bridge_check_capabilities` 可按 `targetId`、`agent` 或 `capabilityId` 查询，`refresh: true` 更新轻检查。默认最多返回 32 项并限制报告大小；更多项目用过滤查询，必要信息不靠基础 Markdown 扩张。缓存不是新增用户授权。

首次配置按用途验收现有浏览器、网站账号、网页读写和文件交付。上传本地文件还需在对应 Chrome profile 的 ChatGPT 扩展中开启“允许访问文件网址”；不能只凭扩展安装就承诺发图。[官方上传说明](https://learn.chatgpt.com/docs/chrome-extension#upload-files)

Claude 接管现有 Chrome 的连接路线需要独立验收；可能涉及远程调试和 Chrome 连接允许提示，具体以当前官方配置为准，不用 Codex 的成功替代 Claude 的结果。[Chrome 官方说明](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)

## 任务进度

桥记录子 Agent 的真实工具开始、结束和最近活动，主控可查询进度。同一未完成工具等待 10 分钟时，桥向主控提供去重提醒，由主控根据原目标决定跟进或换方法；提醒不会自动取消任务，不设整体墙钟硬超时，也不把模型判断失误统一改成程序限制。
