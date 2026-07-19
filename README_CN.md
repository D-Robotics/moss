<div align="center">

<img src="docs/assets/moss-logo.png" alt="Moss" width="96" />

# Moss

**跨平台通用 agent 框架，面向日常 coding、办公、研究与机器人——机器人能力以 skill 接入**

由 [地瓜机器人 (D-Robotics)](https://developer.d-robotics.cc) 打造

[![CI](https://github.com/D-Robotics/moss/actions/workflows/ci.yml/badge.svg)](https://github.com/D-Robotics/moss/actions/workflows/ci.yml)
[![npm agent](https://img.shields.io/npm/v/@rdk-moss/agent.svg?label=%40rdk-moss%2Fagent&color=d4622a)](https://www.npmjs.com/package/@rdk-moss/agent)
[![npm core](https://img.shields.io/npm/v/@rdk-moss/core.svg?label=%40rdk-moss%2Fcore&color=0891b2)](https://www.npmjs.com/package/@rdk-moss/core)
[![Node](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) · **简体中文**

</div>

Moss 是跨平台（Linux / Windows / macOS）agent 框架：像 coding agent 一样在你的仓库里干活，多路径调研最新信息，通过持久 SSH 连接机器人开发板，也能作为库嵌入 TypeScript 应用，或通过 ACP wire protocol 被驱动。你用自然语言描述需求，Moss 理解意图 → 规划步骤 → 调用工具 → 每步如实汇报，全程可见、可打断、可恢复。

**开箱即用，无需 API 密钥**——首次启动自动接入内置地瓜智能网关，一行命令即可开始。

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss 终端演示" width="780" />
</p>

## 快速开始

要求 **Node.js ≥ 22.16**。发布的 CLI 自带可用的地瓜模型——首次运行**无需个人 API 密钥**。

```bash
npm install -g @rdk-moss/agent@latest
cd your-project
moss
```

```bash
moss                                  # 交互式 TUI
moss "review the current diff"        # 一行任务
moss resume --last                    # 恢复最近会话
moss doctor                           # 诊断本地环境
moss --help --all                     # 完整 CLI 参考
```

## 为什么选 Moss

- **运行中可控**——随时调整当前任务、排队后续提示、问一个不打断主任务的旁问、查细节或安全停止。
- **为长任务而生**——命名会话、持久 goal、上下文裁剪 + 压缩、可恢复状态、可选自治循环。
- **默认安全**——`balanced` 配置支持日常开发同时对敏感操作请求确认；无限制执行需显式开启。
- **证据导向的调研**——搜索、直接抓取、RSS 发现、浏览器阅读、并行多源采集，而非只信第一个结果。
- **机器人能力一等公民**——持久设备会话、环境发现、板卡诊断、USB/MIPI 摄像头、ROS 1/2 工具。
- **真正的 harness，不只是 CLI**——provider、会话、工具、hooks、审批、用量事件、异步任务、knowledge、skills、MCP、host adapter、ACP stdio server 都是公开契约。

## 三种使用方式

| 方式 | 命令 | 用于 |
|---|---|---|
| **交互式 TUI** | `moss` | 日常 coding + 研究，带流式输出、工具审批、slash 命令。 |
| **一行 / 管道** | `moss "prompt"` · `echo … \| moss` · `--json` / `--output-format stream-json` | 脚本、CI、流水线。 |
| **ACP stdio server** | `moss agent stdio` | IDE / 编辑器经 JSON-RPC 嵌入（host-neutral wire protocol）。 |

## 文档

按主题拆分的用户指南在 [`docs/user-guide/`](./docs/user-guide/)（英文）：

- [入门](./docs/user-guide/01-getting-started.md) · [Slash 命令](./docs/user-guide/04-slash-commands.md) · [配置](./docs/user-guide/05-configuration.md)
- [会话](./docs/user-guide/17-sessions.md) · [后台任务](./docs/user-guide/20-background-tasks.md) · [Doctor](./docs/user-guide/doctor.md)
- [Skills](./docs/user-guide/08-skills.md) · [MCP servers](./docs/user-guide/07-mcp-servers.md) · [Plan 模式](./docs/user-guide/19-plan-mode.md) · [Sandbox 与权限](./docs/user-guide/18-sandbox.md)

面向 host 作者 + 贡献者：[`docs/`](./docs/)（架构、host-adapter 契约、设计）、[`packages/moss-agent/EXTENDING.md`](./packages/moss-agent/EXTENDING.md)、[`packages/moss-agent/API.md`](./packages/moss-agent/API.md)。

## 嵌入运行时

```bash
npm install @rdk-moss/agent @rdk-moss/core
npx create-moss-app my-agent   # 脚手架一个新 host
```

```ts
import { InMemorySessionStore, MossAgent, OpenAILLMProvider, registerBuiltinTools } from '@rdk-moss/agent';

const agent = new MossAgent({
  llmProvider: new OpenAILLMProvider({ apiKey: process.env.MY_MODEL_API_KEY!, baseUrl: 'https://your-provider.example/v1', defaultModel: 'your-model' }),
  sessionStore: new InMemorySessionStore(),
  model: 'your-model',
  workspaceDir: process.cwd(),
  hooks: { onBeforeToolExec: async ({ tool }) => tool.metadata?.sideEffectClass === 'readonly' ? { approved: true } : { approved: false, reason: 'Host approval required' } },
});
registerBuiltinTools(agent);

for await (const event of agent.streamChat('session-1', 'Check project health')) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
}
await agent.close();
```

公开运行时含：provider、会话存储、流式事件 + `ChatResult` 契约；内置 + 自定义工具、审批、hooks、guardrails、结构化输出；上下文预算、裁剪、压缩、prompt-cache + 用量遥测；knowledge、memory、skills、capability packs、MCP、平台扩展；异步任务、设备 SSH、机器人 helper、诊断。见 [`EXTENDING.md`](./packages/moss-agent/EXTENDING.md) + [`API.md`](./packages/moss-agent/API.md)。

## 配置与权限

默认配置 `balanced`（日常开发，敏感操作需确认）；`readonly` 与 `autonomous` 是两端。安全敏感字段（`approvalPolicy`、`safetyMode`、`trustedTools`、`deniedTools`）用户配置优先于项目——克隆仓库不能降低你的安全姿态。

```bash
moss setup          # 引导配置 provider、base URL、API key、模型
moss config --help  # 所有 config key + 来源
moss doctor         # 健康检查解析后的配置
```

见 [配置](./docs/user-guide/05-configuration.md) + [Sandbox 与权限](./docs/user-guide/18-sandbox.md)。

## 架构

```text
packages/moss/              provider-neutral 契约 + prompt 策略
packages/moss-agent/        运行时、loop、context、工具、TUI、CLI、机器人、ACP
packages/create-moss-app/  可嵌入 agent 项目脚手架
docs/                      设计笔记、架构、benchmark、用户指南
scripts/                   verify、release、benchmark、smoke 工具
```

核心 loop 保持 provider-neutral。coding、研究、机器人、host 特定行为通过工具、prompt 层、capability packs、skills、knowledge 模块、adapter 组合，而非一个单体模式。

## 开发

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm install
npm run verify            # boundaries + hygiene + benchmark + build + typecheck + lint + test
npm run smoke:moss-cli   # 打包 workspaces、安装、验证 CLI + PTY 启动
```

贡献指引见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。安全问题：[`packages/moss-agent/SECURITY.md`](./packages/moss-agent/SECURITY.md)。

## 许可证

[MIT](./LICENSE)
