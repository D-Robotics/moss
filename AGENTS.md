# AGENTS.md

本文件是 Moss 仓库对所有 coding agent 的项目指令（被 git 跟踪、可审查）。

## 仓库身份

Moss 是一个精简的跨平台 coding agent harness：TypeScript / ESM 单包仓库（根 `package.json`，
包名 `moss`，bin 为 `dist/cli.js`），Node ≥ 22.16.0，运行于 Linux / macOS / Windows。

核心能力（也是唯一应当存在的范围）：agent loop、工具框架（`src/tools/`）、上下文管理
（`src/context/`）、provider（`src/provider/`）、安全（`src/safety/`）、会话
（`src/core/session/`）、子代理（`src/core/subagent/`）与 CLI（`src/cli/`、`src/cli-main.ts`）、
设备抽象（`src/device/` + `src/contracts/device.ts` + `src/tools/device-tools.ts`，SSH 连 RDK /
Linux 真机，目标是机器人闭环 Goal→…→Deploy→Verify→Repair→Physical Acceptance）。
共享契约在 `src/contracts/`。

范围变更（2026-09-30 v0.14–v0.20 路线图冻结决策，见
`docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`；同日机器人闭环总指令为
更高优先级的产品方向，两线共存）：

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
| `npm run bench:tui-feel` | TUI 体感基准（`scripts/tui-feel/`，PTY + pyte；缺 python/pyte 时跳过）。结果落 `bench/results/`，不入库 |

## SDK 公共面与 semver（v0.13 起）

`src/index.ts` 的导出面（`dist/index.js` / `dist/index.d.ts`）是受 semver 保护的产品契约，由
`test/sdk-contract.spec.mjs` 快照锁定：

- **minor**：新增导出、既有导出行为向后兼容扩展 → 必须同步更新快照（重跑
  `node scratch/gen-sdk-contract-spec.mjs`）。
- **major（0.x 期间 = 明确的破坏性变更说明）**：删除 / 重命名导出、参数或行为破坏。
- 故意改公共面时快照更新与代码改动同一个 commit；spec 变红说明改动未被视为契约决策。
- `examples/` 下三个嵌入示例是契约的活文档，发版前必须实跑通过。
- **发布口径（2026-10-01 起）**：见 [`docs/release-policy.md`](docs/release-policy.md)——main 是滚动线，
  版本号表示**当前能力级别**；tag 只在 `npm run verify` 全绿 + `examples/` 实跑通过后打，
  tag 说明必须写清"跑了什么、没跑什么"；**不为从未验收的中间版本补打 tag**（v0.14.0–v0.20.0 永久不补）。

## 支持矩阵

| 维度     | 支持                                                                                                                                                                                                                          | 验证方式                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Node     | ≥ 22.16.0（CI 钉 22.16.0 与 24 双档）                                                                                                                                                                                         | CI `Test` 矩阵                           |
| 平台     | Linux / macOS / Windows（Windows 无 PTY smoke，其余全量）                                                                                                                                                                     | CI `Test` 矩阵                           |
| provider | deepseek / qwen / openai / anthropic / openai-compatible                                                                                                                                                                      | 单测 + 冒烟；真实 key 回归按需人工       |
| 交互面   | TTY：全屏渲染器为默认（备用屏 + 鼠标 + 应用内滚动）；`MOSS_TUI_RENDERER=inline`、矮终端、dumb、tmux 鼠标关闭或 GNU screen 回退为 primary screen 内联形态；非 TTY / `MOSS_NO_TUI=1` / Windows：readline REPL | TUI spec 家族 + PTY smoke（macOS/Linux） |

不在表内的组合（其他 Node 大版本、其他 provider 协议）未验证，不支持。

## 结构导航

| 想改什么                                                | 去哪                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Agent loop / 轮次控制 / nudge                           | `src/core/loop/`                                                                             |
| 达标驱动自主执行（/goal 验收门）                        | `src/core/loop/goal-loop.ts`                                                                 |
| MossAgent / 配置 / 事件                                 | `src/core/agent/`                                                                            |
| 工具注册与执行管线                                      | `src/tools/builtin.ts`、`src/core/tools/`                                                    |
| 内置工具实现                                            | `src/tools/*.ts`                                                                             |
| 设备契约 / SSH 连接 / 观测解析                          | `src/contracts/device.ts`、`src/device/`、`src/tools/device-tools.ts`                        |
| 上下文 / 压缩 / token                                   | `src/context/`                                                                               |
| LLM provider                                            | `src/provider/`                                                                              |
| CLI / REPL / 命令                                       | `src/cli/`、`src/cli-main.ts`                                                                |
| CLI 壳（v0.22 起对齐 Claude Code / codex，动态 import） | `src/cli/tui/`（app.ts 外壳 + transcript.ts 语法投影 + text.ts 单元格宽度 + help.ts 键位表） |
| MCP 客户端（v0.16 起）                                  | `src/core/mcp/`                                                                              |
| 轻量 skills（v0.16 起）                                 | `src/core/skills/`                                                                           |
| 统一 Task Runtime 协议（状态机/事件/快照）              | `src/contracts/task-runtime.ts`                                                              |
| 统一 Task Runtime 引擎/存储/裁决/能力发现               | `src/core/task/`（engine、store、verdict、capability、agent-turn）                           |
| TUI 任务投影层（CLI 壳的读路径）                        | `src/core/task-runtime/`（artifacts + runtime 视图模型）                                     |
| 契约（prompt、soul、async-task）                        | `src/contracts/`                                                                             |
| 错误 / 日志                                             | `src/errors.ts`、`src/logger.ts`                                                             |

**分层规则**：依赖只能指向内层（contracts → errors/logger/utils/safety → provider/context/device → core → tools → cli）。ESLint `moss/boundary-*` 规则（`eslint.config.mjs`）强制执行——新增 import 前先看边界规则，不要申请豁免除非是新的合法端口。

## 设备子系统（robotics closed loop P0）

- 设备目标从 `MOSS_DEVICE_HOST/PORT/USER/KIND` + `MOSS_DEVICE_PASSWORD`（或 `MOSS_DEVICE_KEY`）解析，
  凭据只在 env/.env，绝不写入 DeviceTarget / 日志 / 子进程环境（`safeChildEnv` 会剥离）。
- `device_info/processes/resources/temperature/file_read/file_list` 为 readonly（可并行、自动重试）；
  `device_exec/device_file_write` 为 `device_mutation`，行为按 v0.26 交互模式分档：`manual` /
  `acceptEdits` 逐次询问（allow 规则可豁免），`full`（默认）放行，`plan` 类级拒绝，deny 规则在
  任何模式下都赢。工具名已被 subagent scope、截断预算、loop-guard 等按保留名引用，
  改名等于破坏契约。
- 单测用 `test/helpers/in-process-ssh-device.mjs`（进程内 ssh2 服务器，真协议握手）；
  mock 只准用于单测，能力证明必须打真实设备（参照 `scratch/real-device-verify.mjs` 的做法）。

## 任务契约 / 证据 / 验收（robotics closed loop P0-1/2/8 + Task OS）

- 闭环的"完成"判定链：`task_define`（Goal + 可机检 acceptance criteria）→ `device_deploy` /
  `device_exec` / `run_tests` 执行 → `record_evidence`（Expected/Observed/Result 结构化证据）→
  `task_acceptance`（按 metric 匹配最新 evidence 评估；缺证据 = 未完成，latest-wins 支持修复后复测）。
- 工件持久化在工作区 `.moss/`：`tasks.jsonl`、`evidence.jsonl`、`deployments.jsonl`、
  `acceptance.jsonl`，加 Task OS 的 `task-events.jsonl`（生命周期时间线）、
  `task-failures.jsonl`、`task-repairs.jsonl`——这是任务可复现、可追踪、可分析的数据基础。
- **统一 Task Runtime（2026-09-30 Task OS 起）**：一切"完成机制"合一于一个事件驱动状态机
  （`contracts/task-runtime.ts`：draft→…→verifying→diagnosing→repairing→reverifying→accepted/failed；
  非法转移抛 `EXECUTION_STATE_INVALID`，PASS 只能来自 verdict provider，模型散文永远不是事件）。
  - 引擎 `core/task/task-engine.ts`：runTask/resumeTask 驱动 plan→execute→verify→repair→accept；
    goal-loop 与 robotics 验收统一为 VerdictProvider（命令裁决 > 契约裁决，`core/task/verdict.ts`）。
  - `task_define` 新建任务即入状态机（task*created→plan_ready）；`task_acceptance` 落
    verification_started/acceptance*\* 事件；`record_failure`/`record_repair`/`task_plan_update`
    是一等公民工具；`record_evidence`/`device_deploy` 落 info 事件到 timeline。
  - 四入口同一行为：`moss task run/resume/status/timeline`（headless，exit 0 仅当 accepted）、
    REPL `/task`、SDK（`runTask` 等，semver 保护）、TUI（读同一份 `.moss/` 工件）。
  - `runtime_state` 类工具不进审批（moss 自身 `.moss/` 记账）；危险类不变。
  - LoopScheduler `onAcceptanceVerdict` 把 /goal 与 MOSS_GOAL_VERIFY_LOOP 的裁决镜像进统一 runtime。
  - 能力发现：`core/task/capability.ts` 按 goal 匹配 skills/内置工具/MCP，注入 planning 上下文。
- Agent 不得以散文宣布任务成功；成功 = acceptance PASS + 背后 evidence。verify 子代理 scope 已带
  `record_evidence` / `task_acceptance`。
- 完成门（acceptance completion gate）在 MossAgent 内置：本 run 定义过 task_define 而无验收裁决时，
  终稿会被拦截一次并注入修正（跑 task_acceptance / 修复 / 诚实报 FAIL），之后放行——不无限劫持。
  runtime 已裁决过（engine 或上一 run 落过 accepted）时直接放行。
- Robotics benchmark：`bench/tasks/device-*` 设备任务用 `requiresEnv`（无 MOSS_DEVICE_HOST 时跳过不判负）
  与 `passEnv`（凭据从父进程透传，不进仓库）；真实样本：device-observe-evidence 与
  device-deploy-verify（tier:hard）均已 1/1 PASS（deepseek-flash 驱动真机全链）。
- Task OS benchmark：`bench/tasks/task-os-{a-coding,b-device,c-failure-repair}`；C 类是"故障→诊断→
  修复→复验→验收"全链证明（oracle 必须先 FAIL 再修复）；产品指标聚合
  `node scripts/task-os-metrics.mjs [run-dir...]`。

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

## 会话与工作区纪律（2026-10-01）

- **一个工作区同一时间只允许一个写会话**。同一 checkout 里并发跑两个 agent 会话（或"会话 + 未提交的手动编辑"）
  会让"谁的改动"不可判定：2026-10-01 实测，另一个会话正在编辑 `src/cli/tui/panels.ts`/`terminal-text.ts`，
  本会话的 `git status` 出现非本会话改动，`tsc` 在两次相邻运行间给出不同结论（对方瞬时半成品状态）。
- 长任务 / 无人值守运行一律在独立 worktree 开工：`git worktree add ../moss-<topic> -b <topic>`，
  build / test / bench / `dist/` 全部隔离在该 worktree 内；完成后再合并或推送。
- **禁止 `git add -A` / `git add .`**：只按路径暂存本次会话的改动。工作区里可能有他人未提交的改动；
  另注意 worktree 的 `node_modules` 是符号链接时，`.gitignore` 的 `node_modules/` 规则不匹配，它会显示为 untracked。
- 提交前 `git status --short` 必须只剩本次会话预期改动的文件；出现外来改动先停下来确认，不要顺手提交他人半成品。
- 跑 bench / 全量测试前确认没有其他会话在同一 worktree 构建（曾在 bench 期间 `npm run build` 破坏 A/B 对照结果）。
- 收工报告要写清 worktree 与 main 的关系（分支名、commit、是否已 push），不留"离线成果"。
