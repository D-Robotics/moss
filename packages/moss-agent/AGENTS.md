# AGENTS.md — packages/moss-agent

`@rdk-moss/agent`：独立 agent 运行时 + `moss` CLI。仓库级规则见根目录 [`AGENTS.md`](../../AGENTS.md)，本文件只写包内导航与热区。

## 构建与测试前置

- 本包 `build` 依赖 `@rdk-moss/core`（prebuild 会自动先构建 core）；改 core 契约后必须重建再测。
- `npm test` 为 build-first 全量（257+ spec）；聚焦迭代用过滤路由：

```bash
npm run build
npm run test:filter -- --filter tool-loop-guard
```

- 本地开发 CLI：`npm run cli -- "<prompt>"`（tsx 直跑 `src/cli.ts`），或构建后 `node dist/cli-main.js`。

## 模块地图（src/）

| 目录 | 职责 |
|---|---|
| `core/agent` | `MossAgent` 运行时主体（嵌入面：`MossAgent` / `streamChat` / hooks） |
| `core/loop` | agent loop、loop scheduler（`/loop`、`/goal` 自动化） |
| `core/session` | session 管理、resume |
| `core/tools` | 工具框架（声明 side-effect 元数据、审批、replay） |
| `core/llm` / `provider` | LLM providers（非流式必须声明 `capabilities: { streaming: false }`） |
| `cli/` | `moss` CLI：参数、命令分发、TUI、approval |
| `cli-main.ts` / `cli.ts` | CLI 入口（oneshot / piped / TUI） |
| `context/` | 上下文窗口管理与压缩（compaction） |
| `channels/` | 会话通道 |
| `memory/` `skills/` `skill-learning/` `teaching/` `mesh/` `mcp/` `observability/` | in-tree 子系统，经 `package.json` subpath exports 暴露（`./memory`、`./teaching`…），并须从 main barrel `src/index.ts` re-export |
| `safety/` | 审批钩子、safePath、safetyMode |
| `tools/` | builtin 工具（子进程一律走 `utils/run-process.ts`） |
| `utils/` | 进程/文件/locale 等基础设施 |

完整扩展面（persona / skills / commands / tools / model / automation / embedding）见 [`EXTENDING.md`](EXTENDING.md)。

## 热区警示（改动频率最高的路径）

以下文件历史 churn 最高，改动前先读现有聚焦测试、改后用过滤路由跑对应 spec：

- `src/cli/coding-completion-gate.ts`（完成门禁；对应 `test/coding-completion-gate.spec.mjs`）
- `src/cli/tui.ts`（默认 TUI，interactionMode 语义）
- `src/cli-main.ts`（oneshot / piped 入口，slash command 分发）
- `src/core/loop/agent-loop.ts`、`src/core/agent/moss-agent.ts`（运行时主链）

跨包注意：`packages/moss`（core 契约）与本包存在 co-change 历史；改 `@rdk-moss/core` 的契约面（`src/contracts/*`）时同步检查本包的消费点。

## 包内不变量速查

- 每个 subpath export 在 `src/index.ts` 有匹配 barrel export 或显式 `@internal` 注。
- 工具错误走 `MossError` / `wrapAsMoss`；无 module-level 可变状态。
- 面向用户的成功消息必须来自真实操作结果，禁止固定字符串。
