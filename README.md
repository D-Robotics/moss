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

> 还没发到 npm registry（`"private": true` 先留着）。一条命令安装：

```bash
npm install -g github:QiaolongLi1201/moss   # prepare 会构建；需要 Node ≥ 22.16
moss setup                                 # 配置 provider / 模型 / API key（输入不回显）
moss                                       # 进入交互界面
```

从克隆开发：`git clone https://github.com/QiaolongLi1201/moss && cd moss && npm ci && npm run build && npm link`。已安装的 Moss 用 `moss update` 打印升级命令（npm 全局或 git 克隆），它不会自己执行。发到 registry 时删掉 `"private": true`，再 `npm publish --access public`。

进到交互界面后：

- `moss "整理这个项目的 README"` 直接派活；`@` 引用文件，`!` 执行 shell
- `Shift+Tab` 在模式间切换（`plan` = 只读规划）；`/plan` 进入 plan 模式。`/mode` 仍可用一版
- `Ctrl+V` 粘贴剪贴板图片 / Finder 文件 / 本地路径作为附件（macOS；Linux 用 wl-paste/xclip，Windows 用 PowerShell）
- `/help` 看键位与命令，`/goal <条件>` 做到为止，`/model` 换模型

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

板卡手册（烧录、引脚、TROS / hobot_dnn、规格）由内置 rdk-docs MCP 供给，默认钉在 `rdk-docs-mcp@0.2.0`（BM25 + 标题融合、`noGoodMatch`、板型过滤、按 section 读取页面）。默认在后台连接，不需要设备目标（`MOSS_DEVICE_HOST` 或 `.moss/devices.json` 都不是前置条件），也不阻塞交互界面。自定义或尚未发布的版本可用 `"rdkDocs": {"package": "../rdk-docs-mcp"}` 或 `MOSS_RDK_DOCS_PACKAGE` 指向 npm spec、本地目录或 tarball；该值会作为代码执行，只使用可信来源。`MOSS_NO_RDK_DOCS=1`、`"rdkDocs": false` 或 `"rdkDocs": {"enabled": false}` 关闭；同名 `mcp.json` 条目整段替换内置项。服务器能力随版本而异，Moss 先查询工具清单再按实际 schema 调用。连不上时本会话不查手册，没有缓存，也没有离线副本。审计与保留标准见 [`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`](docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md)。

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
| `moss update`                                                              | 打印升级命令（npm 全局或 git 克隆）；不执行                                         |

> `plugins` / `migrate` / `web` / `agent` 属于已移除的子系统，本构建里会**明确报错**，不会悄悄 fallback。`moss <command> --help` 仍给出该子命令自己的用法。

日常斜杠命令：`/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff` `/permissions` `/clear` `/help`。`Shift+Tab` 循环模式；`/plan` 进入 plan 模式；`/goal <条件>` 持续工作直到条件满足，`/goal clear` 取消。`/resume` 恢复已保存的会话；`/tasks` 列出后台 shell 与子代理。`Esc` 中断当前回复；运行中直接发消息会先 steer，无法 steer 时排在输入区上方（`↑` 取回编辑）。`/mode` `/steer` `/queue` `/loop` 保留为隐藏别名一版（`/loop` 已改为 `/goal`）。`/goal` 没带 `--accept` 时，从工作区已有的测试入口（`package.json` test、Makefile、pytest、`go.mod`）给出验收命令候选，找不到就直说，不编造。`/stop`（别名 `/abort`）只停本会话启动的后台进程。隐藏的 `/task` 是 Task OS 入口（status / timeline / resume / view / verify），`/task verify` 不调模型，只取一次裁决。PASS 只能来自 verdict provider。

常用 flag：

| Flag                                                  | 作用                                 |
| ----------------------------------------------------- | ------------------------------------ |
| `-m/--model` · `--provider` · `--base-url`            | 仅本次运行覆盖                       |
| `-C/--cd <dir>` · `-c/--config k=v`                   | 换工作区 · 覆盖 profile/model/policy |
| `--read-only` · `--workspace-write` · `--full-access` | 本次运行的安全上限                   |
| `--trust-device`                                      | 本进程允许毁灭性设备操作             |
| `--accept-edits` · `--ask-for-approval <p>`           | 审批行为                             |
| `-p/--print` · `--json` · `--output-format <f>`       | 一次性 / 机器可读输出                |

常用环境变量（完整见 `moss config env`）：`MOSS_PROFILE` · `MOSS_WORKSPACE` · `MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` · `MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*` · `MOSS_NO_RDK_DOCS`。

> **头号坑**：模型相关设置**只认配置文件**。`MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` / `MOSS_API_KEY` 即使设了也会被忽略——请用 `moss setup` 或 `moss config set`。

未指定配置文件时，Moss 读取用户配置，并把工作区 `.moss/config.json` 当作项目默认值合并进去（用户配置优先）。`--config-file` 或 `MOSS_CONFIG_FILE` 只加载那个文件，项目 `.moss/config.json` 这一层不会进入本次配置。

## 安全与隐私

- **v0.26 起默认 full**：本地写操作与**可逆**设备变更跳过逐次询问。毁灭性设备操作（重启、刷机、写入 `/boot` 或 `/etc`、改网络、卸系统包、停掉 ssh）仍要确认——full 对齐的是 Claude Code 的「默认少问」，不是对真机的 `--dangerously-skip-permissions`。
- **四态交互模式**（Shift+Tab 循环，或 `/plan` 进入 plan；`/mode` 仍可用一版）：

  | 模式           | 行为                                                                                              |
  | -------------- | ------------------------------------------------------------------------------------------------- |
  | `manual`       | 写操作与设备变更逐次询问                                                                          |
  | `acceptEdits`  | 工作区内文件编辑自动通过，shell 与设备变更仍询问                                                  |
  | `plan`         | 只读规划，写操作与设备变更被拦                                                                    |
  | `full`（默认） | 本地写与可逆设备操作跳过询问；毁灭性设备操作 TTY 确认、headless 拒绝。deny 规则与本机硬拦截仍生效 |

- **权限规则**（`/permissions`，任何模式生效，deny 优先于一切含 full）：
  - 三级 `allow` / `ask` / `deny`，优先级 deny > ask > allow；
  - 语法 `ToolName(pattern)`，用 moss 原生工具名：`/permissions add deny "read_file(./.env)"`、`/permissions add allow "exec(npm run *)"`；
  - 会话级规则下一个工具调用即生效；`/permissions persist` 写用户配置重启仍生效；
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` 是压过任何模式（含 full）的只读上限。
- **本机硬拦截永不撤**：本机 `exec` 的毁灭性命令（`rm -rf /` 等）与路径逃逸在 full 模式下同样被拦——full 跳过的是询问，不是检查。设备侧的同一类命令不硬拦死：TTY 确认、allow 规则，或显式信任之后会真的执行。
- **显式信任设备**（任一即可；deny 仍赢）：`--trust-device`（仅本进程）、`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust=full`、`permissions.trustedDevices` 或 `MOSS_DEVICE_TRUST_DEVICES`（逗号分隔的 host / device id）。确认框里选 `a` 只信任提示里写明的范围（例如同一 unit 的 `systemctl restart` 或 `stop`，或同一命令前缀），不是整台设备的全部毁灭性操作。读取 `/etc/shadow`、私钥、`sshd_config`、`authorized_keys` 归入 `sensitive`：同样要确认，但文案和证据不把它叫成毁灭性修改。中文 locale（`LANG` / `LC_ALL` 以 `zh` 开头）下，确认与拒绝文案为简体中文。每次决定写入 `.moss/evidence.jsonl`（`metric: device_policy`），有进行中的任务时同时写入时间线 `note`。策略说明见 [`docs/superpowers/plans/2026-10-09-device-safety-policy.md`](docs/superpowers/plans/2026-10-09-device-safety-policy.md)。
- **旧键兼容**（一版宽限）：`profile` / `trustedTools` / `deniedTools` / `safetyMode` / `approvalPolicy` 读入即按映射表翻译（cautious→manual+只读上限、balanced→manual、autonomous→full、trustedTools→allow 规则、deniedTools→deny 规则），写侧提示 deprecated，新配置请用 `permissions.*` 块。
- 凭据只从 `.env` 或环境变量读，绝不硬编码、不进日志、不传子进程、不写设备清单。
- 无账号、无云服务、无遥测；provider 是普通 HTTP 端点。

## 质量门与基准

```bash
npm run check    # prettier + eslint（0 warning）+ typecheck
npm run test     # build + 全部 test/*.spec.mjs（当前 235 个，面向 dist 跑）
npm run smoke    # CLI 冒烟：--version / --help / PTY 启动
npm run verify   # check + test + smoke —— 发版前必须全绿

# 真实终端（tmux / GNU screen / Terminal.app），默认不跑；缺哪个终端就跳过哪项
npm run build && MOSS_REAL_TERMINALS=1 npm run test:filter -- --filter tui-real-terminals
```

基准结果留在 `bench/results/`（不入库）：

- `npm run bench` · `npm run bench:ab -- reasoning-high` · `npm run bench:noise`：agent 能力、A/B 与噪声带
- `npm run bench:swe` · `npm run bench:tb`：SWE-bench Verified 锁定子集 · Terminal-Bench
- `npm run bench:deepswe`：DeepSWE v1.1，同一模型下和其他 harness 比（经 Pier 跑，已发布分数在 `bench/boards/deepswe-v1.1-harness.json`）
- `npm run bench:device -- --dry`（或 `--target sim` / `--target real`）：RDK 板卡任务成功率。Moss 裁决通过、且独立探测与证据一致才算 PASS，见 [`docs/bench/device-bench.md`](docs/bench/device-bench.md)
- `npm run bench:tui-feel`：TUI 体感 · `node scripts/task-os-metrics.mjs`：Task OS 指标（轮次 / 工具 / 成功率）

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
- [`docs/cli-parity/`](docs/cli-parity/) —— 与 Claude Code / codex 的命令面基线对照；真实终端清单见 [`tui-real-terminals.md`](docs/cli-parity/tui-real-terminals.md)
- [`docs/bench/device-bench.md`](docs/bench/device-bench.md) —— 设备任务基准怎么跑、指标怎么算
- [`CHANGELOG.md`](CHANGELOG.md) —— 未发版改动
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

> Not on the npm registry yet (`"private": true` stays). One command installs it:

```bash
npm install -g github:QiaolongLi1201/moss   # prepare builds; needs Node ≥ 22.16
moss setup                                 # configure provider / model / API key (hidden input)
moss                                       # start the interactive shell
```

From a clone: `git clone https://github.com/QiaolongLi1201/moss && cd moss && npm ci && npm run build && npm link`. `moss update` prints the upgrade command for an npm global install or a git clone and does not run it. To publish, delete `"private": true`, then `npm publish --access public`.

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

Board manuals (flashing, pinouts, TROS / hobot_dnn, specs) come from the built-in rdk-docs MCP,
defaulting to the pinned `rdk-docs-mcp@0.2.0` (BM25 + title fusion, `noGoodMatch`, board filtering,
and section page reads). Moss connects it in the background by default, with or
without a device target (`MOSS_DEVICE_HOST` or `.moss/devices.json` is not required),
so a cold npx download does not block the interactive shell. To test an unpublished build, set
`"rdkDocs": {"package": "../rdk-docs-mcp"}` or `MOSS_RDK_DOCS_PACKAGE` to an npm spec, local
directory, or tarball. Overrides execute code; use only trusted sources. `MOSS_NO_RDK_DOCS=1`,
`"rdkDocs": false`, or `"rdkDocs": {"enabled": false}` turns it off. A same-named `mcp.json` entry
replaces the builtin. Tool features vary by package version, so Moss discovers names and schemas
before use. If the server cannot be reached, this session does not look up manuals — there is no
cache or offline copy. See [`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`](docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md).

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
| `moss update`                                                              | Print the upgrade command (npm global or git clone); it does not run it             |

> `plugins` / `migrate` / `web` / `agent` belong to removed subsystems and fail loudly
> in this build rather than silently falling back to chat. `moss <command> --help` is that
> command's own usage.

Everyday slash commands: `/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff`
`/permissions` `/clear` `/help`. Shift+Tab cycles modes; `/plan` enters plan mode; `/goal <condition>`
works until the condition is met and `/goal clear` cancels it. `/resume` restores a saved
conversation; `/tasks` lists background shell jobs and sub-agents. Esc interrupts the current
reply; a message typed during a run steers it, and queues above the composer when steering is
refused (Up edits that queue). `/mode` `/steer` `/queue` `/loop` stay as hidden aliases for one
version (`/loop` is now `/goal`). Without `--accept`, `/goal` proposes acceptance commands from
test entry points that exist in the workspace (`package.json` test, Makefile, pytest, `go.mod`)
and says so when it finds none. `/stop` (alias `/abort`) stops only background processes this
session started. The hidden `/task` is the Task OS entry (status / timeline / resume / view /
verify); `/task verify` takes one verdict without a model turn. A PASS still comes only from the
verdict provider.

Key flags: `-m/--model`, `--provider`, `--base-url`, `-C/--cd`, `-c/--config k=v`,
`--read-only` · `--workspace-write` · `--full-access`, `--trust-device`, `--accept-edits`,
`--ask-for-approval <p>`, `-p/--print`, `--json`, `--output-format <f>`.

Key env vars (full list: `moss config env`): `MOSS_PROFILE` · `MOSS_WORKSPACE` ·
`MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` ·
`MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*` · `MOSS_NO_RDK_DOCS`.

> **Gotcha:** model settings are config-only. `MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` /
> `MOSS_API_KEY` are read but ignored — use `moss setup` or `moss config set`.

Without an explicit file, Moss reads the user config and merges `.moss/config.json` from the
workspace as project defaults (the user file wins). `--config-file` or `MOSS_CONFIG_FILE` loads
only that file, so the project `.moss/config.json` layer is not part of the run.

### Safety and privacy

- **Full by default since v0.26**: local writes and **reversible** device changes skip the
  prompt. Destructive device operations (reboot, flashing, writes to `/boot` or `/etc`, network
  changes, removing system packages, stopping ssh) still confirm. Full matches Claude Code's
  "ask less by default", not `--dangerously-skip-permissions` against a robot board.
- **Four interaction modes** (Shift+Tab cycles, or `/plan` to enter plan mode; `/mode` remains for one version):

  | Mode             | Behavior                                                                                                                                                                |
  | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `manual`         | mutations and device changes ask one by one                                                                                                                             |
  | `acceptEdits`    | sandboxed workspace edits auto-approve; shell and device changes still ask                                                                                              |
  | `plan`           | read-only planning; mutations and device changes blocked                                                                                                                |
  | `full` (default) | local writes and reversible device work skip the prompt; destructive device work confirms on a TTY and is refused headless. Deny rules and host hard blocks still apply |

- **Permission rules** (`/permissions`, effective in any mode, deny beats everything incl. full):
  - three levels `allow` / `ask` / `deny`, priority deny > ask > allow;
  - syntax `ToolName(pattern)` with moss-native tool names:
    `/permissions add deny "read_file(./.env)"`, `/permissions add allow "exec(npm run *)"`;
  - session rules take effect on the next tool call; `/permissions persist` writes the user config
    and survives restarts;
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` is a read-only ceiling that compresses any mode
    including full.
- **Host hard blocks never lift**: destructive host `exec` commands (`rm -rf /` …) and path
  escapes stay blocked in full mode — full skips the asking, not the checking. The same shapes on
  the device are not a permanent hard block: a TTY confirmation, an allow rule, or explicit trust
  runs them for real.
- **Trust a device** (any one; deny rules still win): `--trust-device` (this process only),
  `MOSS_DEVICE_TRUST=full`, `permissions.deviceTrust=full`, or `permissions.trustedDevices` /
  `MOSS_DEVICE_TRUST_DEVICES` (comma-separated host or device id). Answering `a` trusts only the
  scope named in the prompt (for example `systemctl restart` or `stop` of that unit, or the same
  command prefix) until the session ends. Reading `/etc/shadow`, private keys, `sshd_config`, or
  `authorized_keys` is a `sensitive` tier: it still confirms, and the copy does not call it
  destructive. Prompts and refusals follow the CLI locale (Simplified Chinese when `LANG` /
  `LC_ALL` starts with `zh`). Every decision is appended to `.moss/evidence.jsonl`
  (`metric: device_policy`) and, when a task is in progress, to its timeline as a `note`.
  Policy: [`docs/superpowers/plans/2026-10-09-device-safety-policy.md`](docs/superpowers/plans/2026-10-09-device-safety-policy.md).
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
npm run test     # build + every test/*.spec.mjs (235 specs, run against dist/)
npm run smoke    # CLI smoke: --version / --help / PTY startup
npm run verify   # check + test + smoke — required before any release

# Real terminals (tmux / GNU screen / Terminal.app); off by default, missing terminals are skipped
npm run build && MOSS_REAL_TERMINALS=1 npm run test:filter -- --filter tui-real-terminals
```

Benchmarks stay out of git in `bench/results/`:

- `npm run bench` · `npm run bench:ab -- reasoning-high` · `npm run bench:noise`: agent capability, A/B, noise band
- `npm run bench:swe` · `npm run bench:tb`: locked SWE-bench Verified subset · Terminal-Bench
- `npm run bench:deepswe`: DeepSWE v1.1 with the model held fixed against other harnesses (runs
  through Pier; published scores in `bench/boards/deepswe-v1.1-harness.json`)
- `npm run bench:device -- --dry` (or `--target sim` / `--target real`): RDK board-task success
  rate. A row passes only when Moss's verdict passes and an independent probe matches the
  evidence — see [`docs/bench/device-bench.md`](docs/bench/device-bench.md)
- `npm run bench:tui-feel`: TUI feel · `node scripts/task-os-metrics.mjs`: Task OS metrics
  (turns / tools / success rate)

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
[`docs/cli-parity/`](docs/cli-parity/) (real-terminal checklist:
[`tui-real-terminals.md`](docs/cli-parity/tui-real-terminals.md)) ·
[`docs/bench/device-bench.md`](docs/bench/device-bench.md) ·
[`CHANGELOG.md`](CHANGELOG.md) ·
[`docs/superpowers/plans/`](docs/superpowers/plans/).

### License

MIT — see [`LICENSE`](LICENSE).
