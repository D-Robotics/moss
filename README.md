<div align="center">

# Moss

**One Intent → One Task → One Agent Loop → One Verified Result.**
一句话意图 → 一个任务 → 一个 agent loop → 一个被验证的结果

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.16%2B-339933.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#支持矩阵)

**中文** · [English](#moss--english)

</div>

Moss 是一个精简的跨平台 coding agent harness，也是一套面向机器人开发的 **Agent Task OS**：
把一句话意图变成带**可机检验收标准**的状态机任务，跑完 agent loop 后——**没有证据背书就不算完成**。
它用 SSH 直连 RDK / Linux 真机，所以这里的"完成"可以是**板子真的做到了**。

- TypeScript / ESM 单包 · Node ≥ 22.16.0 · Linux / macOS / Windows
- 无账号、无云服务、无遥测——provider 就是普通 HTTP 端点
- 四种交互面：全屏 TUI · readline REPL · headless CLI · 可嵌入 SDK

## 快速开始

> 仓库尚未发布到 npm（`private: true`），从源码构建：

```bash
git clone https://github.com/D-Robotics/moss && cd moss
npm install && npm run build && npm link   # npm link 可选：把 `moss` 装到 PATH 上
moss setup                                 # 配置 provider / 模型 / API key（输入不回显）
moss                                       # 进入交互界面
```

进到交互界面后：

- `moss "整理这个项目的 README"` 直接派活；`@` 引用文件，`!` 执行 shell
- `Shift+Tab` 在模式间切换（`plan` = 只读规划），`/mode` 看当前模式
- `Ctrl+V` 粘贴剪贴板图片 / Finder 文件 / 本地路径作为附件（macOS；Linux 用 wl-paste/xclip，Windows 用 PowerShell）
- `/help` 看键位与命令，`/status` 看当前模型与工作区，`/model` 换模型

<details>
<summary>不装到 PATH 也能跑 · 一次性模式 · 会话恢复</summary>

```bash
node dist/cli.js --help                       # 直接跑构建产物
moss "check disk usage"                       # 一次性模式（也支持管道：echo "list files" | moss）
moss resume --last                            # 继续最近一次会话
moss --no-tty                                 # 强制使用 readline REPL
```

</details>

## 为什么是 Moss

普通 coding agent 的"完成"是模型说自己完成了。Moss 把这条判定链做成可审计的机器流程：

```text
task_define（目标 + 可机检验收标准）
  → device_deploy / device_exec / run_tests（真实执行）
  → record_evidence（Expected / Observed / Result 结构化证据）
  → task_acceptance（按 metric 匹配最新证据裁决）
```

- **PASS 只能来自 verdict provider**（命令裁决 > 契约裁决）——模型散文永远不是事件
- 缺证据 = 未完成；`latest-wins` 支持修复后复测
- 每个任务走同一个事件驱动状态机：
  `draft → planning → executing → verifying → diagnosing → repairing → reverifying → accepted | failed`
- 完成门内置在 agent 里：一次 run 定义了任务却没有验收裁决时，终稿会被拦截一次并注入修正——不会无限劫持

所有工件落在工作区 `.moss/`，这是可复现、可追踪、可分析的数据基础：
`tasks.jsonl` · `task-events.jsonl` · `evidence.jsonl` · `deployments.jsonl` · `acceptance.jsonl` · `task-failures.jsonl` · `task-repairs.jsonl`。

## 能力

**写代码。** agent loop 负责轮次控制、上下文压缩与预算、nudge、loop guard；**45 个内置工具**开箱即用（含 **12 个 SSH 设备工具**），覆盖读写文件与补丁、代码搜索、进程与后台任务、联网抓取与搜索、类型 / lint 诊断、跑测试与修复验证、子代理、任务契约。写类工具走审批。会话可保存 / 搜索 / 导出 / fork；`/compact` 压缩历史，`/rewind` 从检查点撤销文件编辑，`/diff` 看改动，`/review` 审查 diff（或某个 GitHub PR）找 bug 与安全问题。

**子代理。** `create_subagent` 派生有 scope 限定的子代理（explore / plan / verify / full），可后台运行、可 `fan_out_subagents` 并发扇出并聚合摘要；写类子代理可跑在独立 git worktree 里，产物以三方补丁合并回父工作区。

**连真机。** 用 SSH 直连 RDK / Linux 板卡。只读：`device_info` · `device_processes` · `device_resources` · `device_temperature` · `device_network` · `device_cameras` · `device_robotics_status` · `device_file_read` · `device_file_list`；写类（逐次审批）：`device_exec` · `device_file_write` · `device_deploy`。注册成清单后可一条命令做多机只读巡检：

```bash
export MOSS_DEVICE_HOST=<board> MOSS_DEVICE_PORT=22 MOSS_DEVICE_USER=root MOSS_DEVICE_PASSWORD=...

moss device add rdk-01 192.168.1.10 --user root --kind rdk
moss device list
moss device test rdk-01
moss device fleet info --devices rdk-01,rdk-02,rdk-03 --concurrency 4
```

一个真实目标长这样，agent 会从目标里发现该用哪些设备工具，逐条验收标准记录 Expected/Observed/Result 证据：

```bash
moss --print "定义任务：相机管线保持 30 FPS 持续 60 秒；部署、运行、记录证据、验收"
```

**扩展。** MCP 客户端（stdio + streamable HTTP，工具懒加载）；轻量 skills（`.moss/skills/<name>/SKILL.md`，渐进披露，`$ARGUMENTS` 传参）；自定义斜杠命令（`.moss/commands/<name>.md`）；人设（`.moss/soul.md`）；生命周期 hook。

**嵌入与自动化。** headless 输出是给脚本 / CI 用的稳定契约；把任务跑到裁决位时，**只有 accepted 才退出码 0**：

```bash
moss --print "summarize this repository"
moss --output-format json "..."     # 或 stream-json（system/init → assistant → user → result）

moss task run --goal "创建 hello.txt 内容为 MOSS_OK 并验证内容" --accept "grep -q MOSS_OK hello.txt"
moss task status && moss task timeline
moss tasks list                     # 只读查看机器人闭环产物
```

`src/index.ts` 的导出面是受 semver 保护的合同，由 `test/sdk-contract.spec.mjs` 快照锁定；`examples/` 下三个可运行集成（`npm run examples`）。

## 命令参考

| 子命令                                                                     | 用途                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `moss`（或 `moss "prompt"`）                                               | 交互界面 / 一次性模式                                                               |
| `moss setup` · `moss auth status\|logout`                                  | 配置向导 · 查看登录态 / 删除已存 key                                                |
| `moss doctor`（别名 `moss status`）                                        | 体检配置 / 凭证 / 工作区 / 运行时                                                   |
| `moss config show\|env\|init\|set\|unset\|validate`                        | 配置读写；`moss config --help` 是键的完整参考，`moss config env` 是环境变量权威清单 |
| `moss resume` · `moss fork` · `moss sessions list\|delete\|search\|export` | 会话恢复 / 分叉 / 管理                                                              |
| `moss task run\|resume\|status\|timeline`                                  | 统一任务运行时（目标进 → 已验证结果出）                                             |
| `moss tasks list\|evidence\|deployments\|acceptance\|device`               | 只读巡检机器人闭环产物                                                              |
| `moss device add\|list\|remove\|test\|fleet`                               | 设备清单与多机只读巡检                                                              |
| `moss mcp add\|list\|remove\|test`                                         | MCP 服务器管理                                                                      |
| `moss skill create\|list`                                                  | 技能管理                                                                            |

> `update` / `plugins` / `migrate` / `web` / `agent` 属于已移除的子系统，本构建里会**明确报错**，不会悄悄 fallback。

交互内斜杠命令：`/status` `/model` `/mode` `/compact` `/task` `/context` `/usage` `/export` `/review` `/sessions` `/doctor` `/diff` `/rewind` `/mcp` `/skills` `/permissions` `/hooks` `/jobs` `/queue` `/steer` `/stop` `/init` `/resume` `/help` `/clear` `/quit`。`/loop` 与 `/goal` 是 `/task run` 的兼容别名——循环运行即任务，PASS 只能来自 verdict provider。

常用 flag：

| Flag                                                  | 作用                                 |
| ----------------------------------------------------- | ------------------------------------ |
| `-m/--model` · `--provider` · `--base-url`            | 仅本次运行覆盖                       |
| `-C/--cd <dir>` · `-c/--config k=v`                   | 换工作区 · 覆盖 profile/model/policy |
| `--read-only` · `--workspace-write` · `--full-access` | 本次运行的安全上限                   |
| `--accept-edits` · `--ask-for-approval <p>`           | 审批行为                             |
| `-p/--print` · `--json` · `--output-format <f>`       | 一次性 / 机器可读输出                |

常用环境变量（完整见 `moss config env`）：`MOSS_PROFILE` · `MOSS_WORKSPACE` · `MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` · `MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*`。

> **头号坑**：模型相关设置**只认配置文件**。`MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` / `MOSS_API_KEY` 即使设了也会被忽略——请用 `moss setup` 或 `moss config set`。

## 安全与隐私

- **v0.26 起默认全开（full 模式）**：跳过逐次询问、`device_mutation` 放行——对齐 Claude Code 出厂默认哲学（bypassPermissions）。防线不靠"多问"，靠规则与硬拦截。
- **四态交互模式**（Shift+Tab 循环，或 `/mode`）：

  | 模式           | 行为                                       |
  | -------------- | ------------------------------------------ |
  | `manual`       | 写操作与设备变更逐次询问                   |
  | `acceptEdits`  | 工作区内文件编辑自动通过，shell 变更仍询问 |
  | `plan`         | 只读规划，写操作与设备变更被拦             |
  | `full`（默认） | 跳过询问；仅 deny 规则与硬拦截生效         |

- **权限规则**（`/permissions`，任何模式生效，deny 优先于一切含 full）：
  - 三级 `allow` / `ask` / `deny`，优先级 deny > ask > allow；
  - 语法 `ToolName(pattern)`，用 moss 原生工具名：`/permissions add deny "read_file(./.env)"`、`/permissions add allow "exec(npm run *)"`；
  - 会话级规则下一个工具调用即生效；`/permissions persist` 写用户配置重启仍生效；
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` 是压过任何模式（含 full）的只读上限。
- **硬拦截永不撤**：毁灭性命令（`rm -rf /` 等）与路径逃逸在 full 模式下同样被拦——full 跳过的是询问，不是检查。
- **旧键兼容**（一版宽限）：`profile` / `trustedTools` / `deniedTools` / `safetyMode` / `approvalPolicy` 读入即按映射表翻译（cautious→manual+只读上限、balanced→manual、autonomous→full、trustedTools→allow 规则、deniedTools→deny 规则），写侧提示 deprecated，新配置请用 `permissions.*` 块。
- 凭据只从 `.env` 或环境变量读，绝不硬编码、不进日志、不传子进程、不写设备清单。
- 无账号、无云服务、无遥测；provider 是普通 HTTP 端点。

## 质量门与基准

```bash
npm run check    # prettier + eslint（0 warning）+ typecheck
npm run test     # build + 全部 test/*.spec.mjs（当前 200 个，面向 dist 跑）
npm run smoke    # CLI 冒烟：--version / --help / PTY 启动
npm run verify   # check + test + smoke —— 发版前必须全绿
```

基准结果留在 `bench/results/`（不入库）：`npm run bench` · `npm run bench:ab -- reasoning-high` · `npm run bench:swe` · `npm run bench:tb` · `node scripts/task-os-metrics.mjs`（Task OS 指标：轮次 / 工具 / 成功率）。

版本号表示**当前能力级别**：`main` 是滚动线，tag 只在 `verify` 全绿且 `examples/` 实跑通过后打。详见 [`docs/release-policy.md`](docs/release-policy.md)。

## 支持矩阵

| 维度     | 支持                                                             | 验证方式                        |
| -------- | ---------------------------------------------------------------- | ------------------------------- |
| Node     | ≥ 22.16.0                                                        | CI 双档（22.16 / 24）           |
| 平台     | Linux / macOS / Windows                                          | CI 矩阵（Windows 无 PTY smoke） |
| provider | deepseek / qwen / openai / anthropic / openai-compatible         | 单测 + 冒烟                     |
| 交互面   | TTY：全屏 TUI；非 TTY / `MOSS_NO_TUI=1` / Windows：readline REPL | TUI spec 家族 + PTY smoke       |

## 文档

- [`AGENTS.md`](AGENTS.md) —— 架构、分层规则、子系统导航、工程约定（工作合同）
- [`docs/release-policy.md`](docs/release-policy.md) —— 一个版本 / tag 声称了什么，又没声称什么
- [`docs/capability-layer.md`](docs/capability-layer.md) —— MCP / device / skill 能力层
- [`docs/cli-parity/`](docs/cli-parity/) —— 与 Claude Code / codex 的命令面基线对照
- [`docs/superpowers/plans/`](docs/superpowers/plans/) —— 设计与路线图记录

## License

MIT（见 [`LICENSE`](LICENSE)）。

---

## Moss — English

**English** · [中文](#moss)

> One Intent → One Task → One Agent Loop → One Verified Result.

Moss is a minimal, cross-platform coding agent harness **and** an Agent Task OS for robot
development. It turns a sentence of intent into a state-machine task with machine-checkable
acceptance criteria, runs it through one agent loop, and **refuses to call it done without a
verdict backed by recorded evidence**. It talks to RDK / Linux robots over SSH, so "done" can
mean _the board actually did it_.

- TypeScript / ESM single package · Node ≥ 22.16.0 · Linux / macOS / Windows
- No account, no cloud service, no telemetry — providers are plain HTTP endpoints
- Four surfaces: full-screen TUI · readline REPL · headless CLI · embeddable SDK

### Quick start

> Not on npm yet (`private: true`) — build from source:

```bash
git clone https://github.com/D-Robotics/moss && cd moss
npm install && npm run build && npm link   # npm link is optional
moss setup                                 # configure provider / model / API key (hidden input)
moss                                       # start the interactive shell
```

Inside Moss: give it a job (`@` to reference files, `!` for shell), `Shift+Tab` to cycle modes
(`plan` = read-only planning), `Ctrl+V` to attach a clipboard image / Finder file / local path
(macOS; Linux: wl-paste/xclip; Windows: PowerShell), `/help` for keys and commands.

<details>
<summary>Run the build output directly · one-shot mode · resume</summary>

```bash
node dist/cli.js --help                       # run the build output
moss "check disk usage"                       # one-shot (or pipe: echo "list files" | moss)
moss resume --last                            # continue the latest session
moss --no-tty                                 # force the readline REPL
```

</details>

### Why Moss

A normal coding agent's definition of done is the model saying so. Moss makes that judgement an
auditable machine process:

```text
task_define (goal + machine-checkable acceptance criteria)
  → device_deploy / device_exec / run_tests (real execution)
  → record_evidence (structured Expected / Observed / Result)
  → task_acceptance (evaluate against the latest evidence per metric)
```

- **PASS can only come from a verdict provider** (command verdict > contract verdict) — model
  prose is never an event.
- Missing evidence = not done; `latest-wins` supports re-verification after a repair.
- Every task runs the same event-sourced state machine:
  `draft → planning → executing → verifying → diagnosing → repairing → reverifying → accepted | failed`.
- The acceptance gate is built in: a run that defined a task but produced no verdict gets its
  final answer intercepted once and corrected — it does not hijack indefinitely.

Artifacts land in the workspace `.moss/`: `tasks.jsonl` · `task-events.jsonl` · `evidence.jsonl` ·
`deployments.jsonl` · `acceptance.jsonl` · `task-failures.jsonl` · `task-repairs.jsonl`.

### Capabilities

**Coding.** Turn control, context compaction and budgets, nudges, loop guards, and **45 built-in
tools** (incl. **12 SSH device tools**) covering files and patches, code search, processes and
background jobs, web, diagnostics, tests, sub-agents, and the task contract; mutating tools go
through approval. Sessions are saved, searchable, exportable, forkable; `/compact`, `/rewind`,
`/diff`, `/review`.

**Sub-agents.** `create_subagent` with scoped children (explore / plan / verify / full),
background runs, `fan_out_subagents` with aggregated summaries, and worktree-isolated writers
merged back via 3-way patch.

**Robots (RDK first).** Read-only `device_info` · `device_processes` · `device_resources` ·
`device_temperature` · `device_network` · `device_cameras` · `device_robotics_status` ·
`device_file_read` · `device_file_list`; approved mutations `device_exec` · `device_file_write` ·
`device_deploy`. Register a fleet and fan out:

```bash
export MOSS_DEVICE_HOST=<board> MOSS_DEVICE_PORT=22 MOSS_DEVICE_USER=root MOSS_DEVICE_PASSWORD=...

moss device add rdk-01 192.168.1.10 --user root --kind rdk
moss device fleet info --devices rdk-01,rdk-02,rdk-03 --concurrency 4
moss --print "define a task: camera pipeline keeps 30 FPS for 60s; deploy, run, record evidence, accept"
```

**Extensibility.** MCP client (stdio + streamable HTTP, lazy tool loading), lightweight skills
(`.moss/skills/<name>/SKILL.md`, `$ARGUMENTS` interpolation), custom slash commands
(`.moss/commands/<name>.md`), persona (`.moss/soul.md`), lifecycle hooks.

**Embedding.** Headless output is a stable contract for scripts and CI; a task's exit code is 0
**only when accepted**:

```bash
moss --print "summarize this repository"
moss --output-format json "..."     # or stream-json (system/init → assistant → user → result)

moss task run --goal "create hello.txt containing MOSS_OK and verify its content" --accept "grep -q MOSS_OK hello.txt"
moss task status && moss task timeline
moss tasks list                     # read-only robotics artifacts
```

The `src/index.ts` export surface is a semver-protected contract, snapshotted by
`test/sdk-contract.spec.mjs`; three runnable integrations live in `examples/` (`npm run examples`).

### Command reference

| Subcommand                                                                 | Purpose                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `moss` (or `moss "prompt"`)                                                | Interactive shell / one-shot                                                        |
| `moss setup` · `moss auth status\|logout`                                  | Setup wizard · check or clear stored credentials                                    |
| `moss doctor` (alias `moss status`)                                        | Health-check config / credentials / workspace / runtime                             |
| `moss config show\|env\|init\|set\|unset\|validate`                        | Config I/O; `moss config --help` lists every key, `moss config env` is the env list |
| `moss resume` · `moss fork` · `moss sessions list\|delete\|search\|export` | Resume / fork / manage sessions                                                     |
| `moss task run\|resume\|status\|timeline`                                  | Unified task runtime (intent in → verified result out)                              |
| `moss tasks list\|evidence\|deployments\|acceptance\|device`               | Read-only robotics artifacts                                                        |
| `moss device add\|list\|remove\|test\|fleet`                               | Device registry + read-only fleet probe                                             |
| `moss mcp add\|list\|remove\|test`                                         | MCP server management                                                               |
| `moss skill create\|list`                                                  | Skill management                                                                    |

> `update` / `plugins` / `migrate` / `web` / `agent` belong to removed subsystems and fail loudly
> in this build rather than silently falling back to chat.

Slash commands: `/status` `/model` `/mode` `/compact` `/task` `/context` `/usage` `/export`
`/review` `/sessions` `/doctor` `/diff` `/rewind` `/mcp` `/skills` `/permissions` `/hooks`
`/jobs` `/queue` `/steer` `/stop` `/init` `/resume` `/help` `/clear` `/quit` (`/loop` and `/goal`
alias `/task run` — a loop run _is_ a task).

Key flags: `-m/--model`, `--provider`, `--base-url`, `-C/--cd`, `-c/--config k=v`,
`--read-only` · `--workspace-write` · `--full-access`, `--accept-edits`, `--ask-for-approval <p>`,
`-p/--print`, `--json`, `--output-format <f>`.

Key env vars (full list: `moss config env`): `MOSS_PROFILE` · `MOSS_WORKSPACE` ·
`MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` ·
`MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*`.

> **Gotcha:** model settings are config-only. `MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` /
> `MOSS_API_KEY` are read but ignored — use `moss setup` or `moss config set`.

### Safety and privacy

- **Full by default since v0.26**: prompts are skipped and `device_mutation` runs — the Claude Code
  factory-default philosophy (bypassPermissions). The guardrails are rules and hard blocks, not
  more questions.
- **Four interaction modes** (Shift+Tab cycles, or `/mode`):

  | Mode             | Behavior                                                          |
  | ---------------- | ----------------------------------------------------------------- |
  | `manual`         | mutations and device changes ask one by one                       |
  | `acceptEdits`    | sandboxed workspace edits auto-approve; shell mutations still ask |
  | `plan`           | read-only planning; mutations and device changes blocked          |
  | `full` (default) | prompts skipped; only deny rules and hard blocks apply            |

- **Permission rules** (`/permissions`, effective in any mode, deny beats everything incl. full):
  - three levels `allow` / `ask` / `deny`, priority deny > ask > allow;
  - syntax `ToolName(pattern)` with moss-native tool names:
    `/permissions add deny "read_file(./.env)"`, `/permissions add allow "exec(npm run *)"`;
  - session rules take effect on the next tool call; `/permissions persist` writes the user config
    and survives restarts;
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` is a read-only ceiling that compresses any mode
    including full.
- **Hard blocks never lift**: destructive commands (`rm -rf /` …) and path escapes are blocked in
  full mode too — full skips the asking, not the checking.
- **Legacy keys** (one release of grace): `profile` / `trustedTools` / `deniedTools` /
  `safetyMode` / `approvalPolicy` are translated on read (cautious→manual+read-only ceiling,
  balanced→manual, autonomous→full, trustedTools→allow rules, deniedTools→deny rules); writing
  them prints a deprecation notice — use the `permissions.*` block for new config.
- Credentials come only from `.env` or the environment: never hardcoded, never logged, never
  passed to child processes, never written to the device registry. No account, no cloud, no
  telemetry.

### Quality gates and benchmarks

```bash
npm run check    # prettier + eslint (0 warning) + typecheck
npm run test     # build + every test/*.spec.mjs (200 specs, run against dist/)
npm run smoke    # CLI smoke: --version / --help / PTY startup
npm run verify   # check + test + smoke — required before any release
```

Benchmarks stay out of git in `bench/results/`: `npm run bench`, `npm run bench:ab -- reasoning-high`,
`npm run bench:swe`, `npm run bench:tb`, `node scripts/task-os-metrics.mjs` (Task OS metrics:
turns / tools / success rate).

A version number states the **current capability level**: `main` is the rolling line, tags are cut
only after `verify` is green and `examples/` pass for real — see
[`docs/release-policy.md`](docs/release-policy.md).

### Support matrix

| Dimension | Supported                                                                | Verified by                         |
| --------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Node      | ≥ 22.16.0                                                                | CI matrix (22.16 / 24)              |
| Platform  | Linux / macOS / Windows                                                  | CI matrix (no PTY smoke on Windows) |
| Providers | deepseek / qwen / openai / anthropic / openai-compatible                 | unit tests + smoke                  |
| Surfaces  | TTY: full-screen TUI; non-TTY / `MOSS_NO_TUI=1` / Windows: readline REPL | TUI specs + PTY smoke               |

### Documentation

[`AGENTS.md`](AGENTS.md) (architecture and conventions) ·
[`docs/release-policy.md`](docs/release-policy.md) ·
[`docs/capability-layer.md`](docs/capability-layer.md) ·
[`docs/cli-parity/`](docs/cli-parity/) ·
[`docs/superpowers/plans/`](docs/superpowers/plans/).

### License

MIT — see [`LICENSE`](LICENSE).
