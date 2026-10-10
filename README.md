# Discord Agent Bridge

在 Windows 笔记本运行，使用已有 Discord 机器人私聊 Codex / Claude Code。支持双向图片，也可以要求 Agent 把生成或整理的普通文件作为附件发回。文字、图片、会话绑定和原生会话 ID 都会保留；程序重启后继续当前会话。

## 部署与生成工作区

已验证平台为 Windows x64。目标用户需要已配置 Codex CLI 和 Claude Code；供应商、认证和模型别名沿用自己的 CLI / CC Switch 设置。

1. 获取代码及编译后的 `dist/`，复制同平台 `node_modules/` 和 `.local/runtime/`。
2. 将 `config.example.json` 复制为 `.local/config.json`，填写机器人 Token、用户白名单及 CLI 路径。
3. 生成工作区，在其 `README.md` 填写自己的导航，再把桥配置中的 `workspace` 设为同一路径：

```powershell
.\init-workspace.ps1 -Path 'D:\Agent Workspace'
```

4. 运行 `.\start.ps1 -Check` 检查配置，再运行 `.\start.ps1`；代理可在配置设 `proxyPort: 7898` 或用 `.\start.ps1 -ProxyPort 7898`。
5. 需要登录后隐藏启动：以管理员运行 `.\install-startup.ps1 -StartNow`；手动停用用 `.\stop.ps1`。

生成脚本不需要 Node 或联网，只补缺失文件，已有文件原样保留。空 `agents.json` 可以直接使用；远端登记参考单独的 `agents.example.json` 填写。详细前置条件、迁移及登记步骤见 [部署说明](docs/deployment.md)。

## 目录导航

```text
discord-agent-bridge/
├─ README.md                  项目入口
├─ init-workspace.ps1          生成独立 Agent 工作区
├─ start.ps1 / stop.ps1        启动 / 手动停用
├─ install-startup.ps1         登录后后台启动
├─ config.example.json        桥配置示例
├─ runtime-manifest.json      已验证运行时信息
├─ package.json / package-lock.json
├─ docs/                      使用、部署和开发说明
├─ workspace-template/        通用上下文与注册表模板
├─ scripts/                   监督进程、远端执行器与任务辅助脚本
├─ src/                       桥源码
├─ test/                      自动化测试
├─ dist/ / node_modules/      构建及依赖，不进 Git
└─ .local/                    运行时、配置、会话、日志与备份，不进 Git
```

Agent 工作区独立于桥代码，可放在任意指定目录：

```text
D:\Agent Workspace/
├─ AGENTS.md                  简短约定与产物回传格式
├─ CLAUDE.md                  引用 AGENTS.md
├─ README.md                  本机职责、上下文初始化入口与工作导航
├─ agents.json                实际跨电脑注册表，默认空表
└─ agents.example.json        远端登记示例，不自动启用
```

机器导航和个人工作习惯放在工作区；技能由各电脑的 CLI 加载。桥提供执行能力，不复制个人指南、技能或认证到项目模板。

## 使用与维护

- [使用说明](docs/usage.md)：主控与子 Agent、私聊指令、图片和文件、模型及强度、任务计数与安全重启。
- [部署与迁移](docs/deployment.md)：工作区生成、配置、代理、数据迁移与跨电脑登记。
- [开发与验证](docs/development.md)：构建、测试和版本升级。

新增或改变主控工具声明后，已有 Codex 原生会话需要 `/new` 才能加载新声明；普通重启仍续接旧会话。工作区模板更新不会覆盖用户资料，更新个人上下文后用 `/new` 重新初始化；普通模型、强度切换可以保留当前会话。
