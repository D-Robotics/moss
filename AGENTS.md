# AGENTS.md

本文件是 Moss 仓库对所有 coding agent 的项目指令（被 git 跟踪、可审查）。

## 仓库身份

Moss 是一个精简的跨平台 coding agent harness：TypeScript / ESM 单包仓库（根 `package.json`，
包名 `moss`，bin 为 `dist/cli.js`），Node ≥ 22.16.0，运行于 Linux / macOS / Windows。

核心能力（也是唯一应当存在的范围）：agent loop、工具框架（`src/tools/`）、上下文管理
（`src/context/`）、provider（`src/provider/`）、安全（`src/safety/`）、会话
（`src/core/session/`）、子代理（`src/core/subagent/`）与 CLI/TUI（`src/cli/`、`src/cli-main.ts`）。
共享契约在 `src/contracts/`。不要重新引入 memory / skills / mesh / mcp / observability /
orchestration / web-ui 等已移除的子系统。

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

| 命令                                     | 用途                                          |
| ---------------------------------------- | --------------------------------------------- |
| `npm run build`                          | 清理并构建到 `dist/`                          |
| `npm run typecheck`                      | 全量类型检查                                  |
| `npm run lint` / `lint:fix`              | ESLint（0 warning）                           |
| `npm run test`                           | 构建 + 运行 `test/*.spec.mjs`（面向 `dist/`） |
| `npm run test:filter -- --filter <name>` | 只跑匹配的 spec（至少匹配 1 个，否则失败）    |
| `npm run smoke`                          | CLI 冒烟（版本 / 帮助 / PTY 启动）            |
| `npm run check`                          | format:check + lint + typecheck               |
| `npm run verify`                         | check + test + smoke，交付前必须绿            |

## 结构导航

| 想改什么                         | 去哪                                      |
| -------------------------------- | ----------------------------------------- |
| Agent loop / 轮次控制 / nudge    | `src/core/loop/`                          |
| MossAgent / 配置 / 事件          | `src/core/agent/`                         |
| 工具注册与执行管线               | `src/tools/builtin.ts`、`src/core/tools/` |
| 内置工具实现                     | `src/tools/*.ts`                          |
| 上下文 / 压缩 / token            | `src/context/`                            |
| LLM provider                     | `src/provider/`                           |
| CLI / TUI / 命令                 | `src/cli/`、`src/cli-main.ts`             |
| 契约（prompt、soul、async-task） | `src/contracts/`                          |
| 错误 / 日志                      | `src/errors.ts`、`src/logger.ts`          |

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
