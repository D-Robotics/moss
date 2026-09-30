# AGENTS.md

本文件是 Moss 仓库对所有 coding agent 的项目指令（被 git 跟踪、可审查）。

## 仓库身份

Moss 是一个精简的跨平台 coding agent harness：TypeScript / ESM 单包仓库（根 `package.json`，
包名 `moss`，bin 为 `dist/cli.js`），Node ≥ 22.16.0，运行于 Linux / macOS / Windows。

核心能力（也是唯一应当存在的范围）：agent loop、工具框架（`src/tools/`）、上下文管理
（`src/context/`）、provider（`src/provider/`）、安全（`src/safety/`）、会话
（`src/core/session/`）、子代理（`src/core/subagent/`）与 CLI（`src/cli/`、`src/cli-main.ts`，交互界面为
readline REPL）。
共享契约在 `src/contracts/`。

范围变更（2026-09-30 v0.14–v0.20 路线图冻结决策，见
`docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`）：

- **解冻**：MCP 客户端（仅客户端；stdio + streamable HTTP 双传输、工具懒加载、
  `src/core/mcp/`，v0.16）与轻量 skills（SKILL.md 渐进披露、`src/core/skills/`，v0.16）。
- **翻案**：v0.17 起引入可选全屏 TUI（ink，严格圈禁 `src/cli/tui/` 动态 import，
  无 TTY 或 `--no-tty` 回退 readline REPL；REPL 永久保留）。
- **维持冻结**：memory（跨会话自动记忆）/ mesh / observability / orchestration /
  web-ui / 插件市场。不要重新引入这些子系统。

## 代码规范（必须遵守）

- Prettier 负责格式；TypeScript/JavaScript/MJS 文件名用 kebab-case；Node 内置模块用
  `node:` 前缀；仅类型导入用 `import type`；ESM 相对导入带 `.js` 后缀。
- 禁止 `any`；不要留下未处理的 Promise；跨工具 / provider / CLI 边界的错误转换为
  `MossError`（`src/errors.ts`）并保留原始 cause；禁止 `catch (err: any)`。
- 所有子进程必须经 `src/utils/run-process.ts`（`runProcess` / `spawnProcess` /
  `runProcessSync`），工具执行路径禁用 `execFileSync` / `execSync`。
- 新工具必须声明 side-effect 元数据（readonly vs mutating 驱动审批）。
- 非流式 LLM provider 必须声明 `capabilities: { streaming: false }`。
- 面向用户的成功消息必须来自真实结果（probe / exit code / post-condition），不得是固定字符串。
- 凭据只从 `.env` 或环境变量读；不硬编码、不写日志、不传给外部服务。

## 常用命令

| 命令                                                                             | 用途                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                  | 清理并构建到 `dist/`                                                                                                                                                 |
| `npm run typecheck`                                                              | 全量类型检查                                                                                                                                                         |
| `npm run lint` / `lint:fix`                                                      | ESLint（0 warning）                                                                                                                                                  |
| `npm run test`                                                                   | 构建 + 运行 `test/*.spec.mjs`（面向 `dist/`）                                                                                                                        |
| `npm run test:filter -- --filter <name>`                                         | 只跑匹配的 spec（至少匹配 1 个，否则失败）                                                                                                                           |
| `npm run smoke`                                                                  | CLI 冒烟（版本 / 帮助 / PTY 启动）                                                                                                                                   |
| `npm run check`                                                                  | format:check + lint + typecheck                                                                                                                                      |
| `npm run verify`                                                                 | check + test + smoke，交付前必须绿                                                                                                                                   |
| `npm run bench [-- --task <id> --samples <n>]`                                   | agent 能力基准（`bench/tasks/`，DeepSeek 基准模型，结果落 `bench/results/`，不入库）                                                                                 |
| `npm run bench:ab -- <engine>`                                                   | hard 层 A/B 对照（`best-of-n` / `reasoning-high` / `model-routing`，`--samples <n>` 可调），输出默认开/关建议                                                        |
| `npm run bench:noise -- <label1> <label2> [...]`                                 | 同 SHA 重复跑聚合成噪声带（`bench/results/noise-band.json`）                                                                                                         |
| `npm run bench:swe -- [--samples N --concurrency K --label L --filter s --eval]` | SWE-bench Verified 100 实例锁子集（`bench/boards/swebench-instances.json`）：容器内 moss headless 产 patch + 官方 swebench harness 判分；密钥经 `MOSS_BENCH_API_KEY` |

## SDK 公共面与 semver（v0.13 起）

`src/index.ts` 的导出面（`dist/index.js` / `dist/index.d.ts`）是受 semver 保护的产品契约，由
`test/sdk-contract.spec.mjs` 快照锁定：

- **minor**：新增导出、既有导出行为向后兼容扩展 → 必须同步更新快照（重跑
  `node scratch/gen-sdk-contract-spec.mjs`）。
- **major（0.x 期间 = 明确的破坏性变更说明）**：删除 / 重命名导出、参数或行为破坏。
- 故意改公共面时快照更新与代码改动同一个 commit；spec 变红说明改动未被视为契约决策。
- `examples/` 下三个嵌入示例是契约的活文档，发版前必须实跑通过。

## 支持矩阵

| 维度     | 支持                                                      | 验证方式                           |
| -------- | --------------------------------------------------------- | ---------------------------------- |
| Node     | ≥ 22.16.0（CI 钉 22.16.0 与 24 双档）                     | CI `Test` 矩阵                     |
| 平台     | Linux / macOS / Windows（Windows 无 PTY smoke，其余全量） | CI `Test` 矩阵                     |
| provider | deepseek / qwen / openai / anthropic / openai-compatible  | 单测 + 冒烟；真实 key 回归按需人工 |

不在表内的组合（其他 Node 大版本、其他 provider 协议）未验证，不支持。

## 结构导航

| 想改什么                          | 去哪                                      |
| --------------------------------- | ----------------------------------------- |
| Agent loop / 轮次控制 / nudge     | `src/core/loop/`                          |
| 达标驱动自主执行（/goal 验收门）  | `src/core/loop/goal-loop.ts`              |
| MossAgent / 配置 / 事件           | `src/core/agent/`                         |
| 工具注册与执行管线                | `src/tools/builtin.ts`、`src/core/tools/` |
| 内置工具实现                      | `src/tools/*.ts`                          |
| 上下文 / 压缩 / token             | `src/context/`                            |
| LLM provider                      | `src/provider/`                           |
| CLI / REPL / 命令                 | `src/cli/`、`src/cli-main.ts`             |
| 全屏 TUI（v0.17 起，动态 import） | `src/cli/tui/`                            |
| MCP 客户端（v0.16 起）            | `src/core/mcp/`                           |
| 轻量 skills（v0.16 起）           | `src/core/skills/`                        |
| 契约（prompt、soul、async-task）  | `src/contracts/`                          |
| 错误 / 日志                       | `src/errors.ts`、`src/logger.ts`          |

**分层规则**：依赖只能指向内层（contracts → errors/logger/utils/safety → provider/context → core → tools → cli）。ESLint `moss/boundary-*` 规则（`eslint.config.mjs`）强制执行——新增 import 前先看边界规则，不要申请豁免除非是新的合法端口。

## 测试约定

- 测试在 `test/*.spec.mjs`，import 构建产物 `dist/`，由 `scripts/run-package-tests.mjs` 顺序执行。
- 新增 spec 文件名包含被测模块名，保证 `--filter` 可命中。
- Bug 修复需要"修复前失败、修复后通过"的回归测试。
- 动态 ESM import 一律 `pathToFileURL(...).href`（Windows 兼容）。

## 纪律

- 改代码前先做结构导航（符号/调用关系），读真实源码确认，不从文件名猜行为。
- 只做必须做的改动，匹配现有风格；修一个 bug 时 grep 同类形状。
- 行为验证优先于静态检查：逻辑改动后实际运行 CLI 验证一次。
- 报告真实命令与结果；没有观察到 post-condition 就不报成功。
