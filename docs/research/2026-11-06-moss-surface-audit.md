# Moss 能力面审计：交互面 × 能力矩阵、重叠、删除/新增候选、run 生命周期根因方案

- 日期：2026-11-06（02:30-02:40 +08:00）
- 仓库：`/Users/d-robotics/Desktop/RDK_Studio/moss`，`@rdk-moss/agent@0.31.0`，HEAD `ab9ad905`
- 工作树：**审计期间被并行改动**（详见下方"审计期间仓库在动"与 §0.5）；`dist/` 构建于 2026-11-06 02:37，已含这些改动，故 `--help` 实测有效
- 方法：`node dist/cli.js --help` / `--help --all` 实跑；`node -e` 只读 import `dist/` 的注册表（工具、slash 命令、nudge、退出码）；`read`/`grep` 读 `src/` 与 `README.md`；行数用 `find|wc`
- 约束：**只写本文件**；未改 `src/`、未 commit/push、未改 AGENTS/backlog；未跑 bench、未跑 agent（避免创建 `.moss/` 工件）
- 姊妹文档：`docs/specs/2026-11-06-moss-acceptance-longrun-brainstorm.md`（机制对照）、`docs/research/2026-11-04-cursor-claude-agent-design/moss-architecture-audit.md`（工具/提示词层面）
- 标记：**实测**（跑过命令）／**读码**（`文件:行号`）／`[unknown]`（只读手段无法确定）

> **审计期间仓库在动（必须知道）**：本审计开始（02:30）时工作树干净；交付时（02:40）已有另一路并行改动，
> `git status` = **9 个已修改 + 12 个未跟踪**（`AGENTS.md`/`CHANGELOG.md`/两个 README/`scripts/verify/cli.mjs`/`args.ts`/`command-dispatcher.ts`/`help.ts`/`subcommand-help.ts`）：`README.md`/`README.en.md` 重写（470→200 行，拆到
> `docs/cli-reference.md`/`install.md`/`safety.md`/`rdk-board-deps.md`）、**新增 `moss run` 命令**
> （`src/cli/args.ts`、`command-dispatcher.ts`、`help.ts`，AGENTS 记作 B128）、新增
> `scripts/verify/readme-parity.mjs` + stage。本文"命令面/README"结论**以该工作树状态为准**；与
> HEAD `ab9ad905` 的差异在 §0.5 单列。`dist/`（02:37）已含这些改动，故 `--help` 实测有效。

---

## 0. 一页结论

### 0.1 一句话根因

**Moss 不缺能力，缺"一个 run 入口 + 一套账本 + 一个能力面板"。**

能力深度已经超过了产品文档可见的部分（状态机、命令裁决、证据链、自动评审 + 修复、5 个完成闸门都已经实现）；真正的成本在**维度爆炸**：`6 套 run 引擎` × `4 个交互面` × `3 种判定语义` × `4 套账本格式` × `45 个顶层动词（26 CLI + 19 slash）`。用户每多一个意图（"跑到测试通过"），就要在 3-4 个名字里选一个，而这 3-4 个名字的差别**从名字上看不出来**。

证据密度（全部实测/读码，见 §1、§2）：`moss loop`、`moss task run --accept`、`/goal --accept`、`MOSS_GOAL_VERIFY_LOOP=1`、`moss workflow run`、`moss superagent work` 这 6 条路径都在做"跑一次 → 用命令判定 → 不过再来"；它们各自的账本格式、退出码、状态词、恢复命令都不一样。
而且工作树刚加了第 7 个名字 `moss run`（= `task run` 的快捷方式，B128）——方向对；但只要 `--until`/`--plan` 还没收进来，名字数就只是从 6 变 7。

**反面对照**：仓库的验证基础设施同期已从"4 个 verify stage"长到 **85 个 stage**（`scripts/verify/stages/`，fast gate 76 个），几乎每个能力都有探针（loop × 8、task × 12、skill × 7、mcp × 3、review × 2，plugins/workflow/rules/remember 各 1）。也就是说：**能力与验证都不缺，缺的是把它们摆到用户面前的形状。**

### 0.2 数字看板

| 维度                | 实测值                                                                                                                         | 证据                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| src 规模            | 538 文件 / 148,225 行                                                                                                          | `find`                                                                 |
| CLI 占比            | `src/cli` 165 文件 / **57,551 行（38.8%）**，其中 TUI 32 文件 / 12,754 行                                                      | `find`                                                                 |
| 顶层子命令          | **26 声明 / 21 实现 / 3 未实现 / 2 走 AgentReady**（工作树含 `run`）                                                           | `src/cli/args.ts` `KNOWN_COMMANDS`、`command-dispatcher.ts` `COMMANDS` |
| 交互 slash 命令     | **36 行 / 17 hidden / 11 别名 / 10 retired → 19 个可见**                                                                       | `dist/cli/interactive-commands.js`                                     |
| 顶层 flag           | 37 个（子命令另有 2-10 个）                                                                                                    | `src/cli/args.ts`                                                      |
| 内置工具            | **51**（readonly 24 / local_write 11 / runtime_state 8 / subagent 5 / device_mutation 3）；deferred 6 / legacy 2 / plan-only 1 | `dist/tools/builtin.js`                                                |
| device 工具         | **13**（10 只读 + 3 变更）                                                                                                     | 同上                                                                   |
| run 引擎 / 名字     | **6 个实现 / 7 个名字**（多出的 `moss run` = `task run` 别名；另有 1 个 env-only）                                             | §2.1                                                                   |
| 账本格式            | **4 套**（goals.jsonl / loops/<id>.jsonl / workflows/<id>/state.json / superagent/state.sqlite）+ Task OS 5 个 jsonl           | §2.1                                                                   |
| 终局闸门            | **4 个串成一条链**（background → plan → acceptance → verification）+ follow-up-guard                                           | `src/core/agent/moss-agent.ts:1834-1852`                               |
| nudge               | 29 个 id；completion 相关 7 个                                                                                                 | `src/core/loop/nudges/disable.ts`                                      |
| verify 入口         | **8 个**（§2.5）                                                                                                               | §2.5                                                                   |
| capability 列举入口 | **5 处**（`/skills` `/agents` `/rules` `/mcp` `moss skill list`），而 registry 有统一 `list()` 却无人调用                      | `src/core/capabilities/registry.ts:34`                                 |
| 验证 stage          | 85 个（fast gate 76、默认预算 60s；近两天从 4 个长到 85 个）                                                                   | `scripts/verify/cli.mjs`                                               |
| 文档                | 82 个 md / 26,192 行；README 已重写为 200 行 + 4 篇拆出文档（工作树）                                                          | §2.9                                                                   |

### 0.3 五条删除 + 五条新增（详表见 §3）

**删除（按"价值/风险"排序，均给替代路径）**

| #   | 删除                                                                   | 替代路径                                          | 风险           |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------- | -------------- |
| X1  | `moss tasks` 整个子命令组（5 个）                                      | `moss task view <kind>` + `moss device list/test` | 低             |
| X2  | `MOSS_GOAL_VERIFY_LOOP` / `MOSS_GOAL_VERIFY_CMD`（env-only 第 4 引擎） | `moss loop --until "<cmd>"`                       | 中（脚本兼容） |
| X3  | `moss device fleet <probe>`                                            | `moss device test` + agent 的 `device_probe`      | 低             |
| X4  | `moss update`（只打印命令）+ `install/login/upgrade/logout` 4 别名     | `moss doctor` 的版本提示 + README 升级章节        | 低             |
| X5  | `migrate` / `web` / `agent` 三个"必报错"占位命令                       | 直接 unknown command + `moss --help`              | 极低           |

**新增（按价值/风险排序）**

| #   | 新增                                                         | 为什么                                                                                                                                          | 风险                       |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| N1  | `moss run`（统一 run 动词）                                  | 把 6 个引擎收成 1 个动词 + 3 个修饰符。**工作树已落地最小版**（`run` = `task run` 快捷方式，B128），缺 `--until`/`--plan`/`--resume` 与统一账本 | 高（核心重构，需分层迁移） |
| N2  | `moss runs list\|show\|prune\|export`（统一账本）            | 4 套账本 → 1 套；`RunOutcome` 5 状态已有，只差持久化                                                                                            | 中                         |
| N3  | `moss capabilities [--json]` + `/capabilities`               | `CapabilityRegistry.list()` 已存在但**没有任何用户入口**                                                                                        | 低                         |
| N4  | 首个 5 分钟"下一步"输出（`next:` 行 + `moss doctor --next`） | **部分已有**：`task run` 非通过时会打 `next:`（B119，`task-next-steps` 有探针）；缺 setup 之后与 `moss loop` 结束时的 next                      | 低                         |
| N5  | `moss remember --list / --forget`（写路径已有，读写不对称）  | `/remember` 只能追加，不能看/删（除手改 AGENTS.md）                                                                                             | 低                         |

### 0.4 最该做的一条（根因，不是补丁）

**把 `RunOutcome`（已完成 5 状态：`completed` / `incomplete` / `verify_failed` / `blocked` / `unverified`，`src/cli/run-outcome.ts:43-50`）提升为所有 run 引擎的公共终局记录并落账本。**
今天它只在 headless one-shot 里由启发式算出；而 4 个完成闸门已经产出了结构化的 `kind` + `reason`（`missing-review` / `review-fail` / `unverified-change` / `no-verdict` / `unrepaired-fail`，`verification-completion-gate.ts:194-273`、`acceptance-completion-gate.ts:184-196`）。两边**只差一次映射 + 一次写盘**：run 结束时把 `RunOutcome` 写进 `.moss/runs/<id>/run.json`，`moss runs show latest` 直接回答"这次为什么停在 incomplete"。这是所有"多引擎/多账本"问题的共同母体。

---

### 0.5 审计期间已被别人做的事（避免重复投入）

| 事项                                                                                                                    | 状态                    | 证据                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `moss run "<intent>" [--accept "<cmd>"]`（`task run` 快捷方式）                                                         | **已落地（未提交）**    | `git diff src/cli/args.ts src/cli/command-dispatcher.ts src/cli/help.ts`；AGENTS 记作 B128；`--help` 首屏第 4 行 |
| README 重写（470→200 行）+ 拆出 `docs/cli-reference.md`（75）/`install.md`（180）/`safety.md`（39）/`rdk-board-deps.md` | **已落地（未提交）**    | `git status`、`wc -l`                                                                                            |
| README 中日 1:1 + 链接可解析 + 工具数/build 一致 + 无内部工单号 的 parity 探针                                          | **已落地（未提交）**    | `scripts/verify/readme-parity.mjs`（7 项断言）+ `scripts/verify/stages/readme-parity.mjs`（已进 fast gate）      |
| 验证从 4 stage → **85 stage**                                                                                           | 已落地（HEAD 前后几天） | `scripts/verify/stages/`、`scripts/verify/cli.mjs` `FAST_GATE`(76)                                               |
| `task run` 的 `next:` 行（B119）、Ctrl+C 暂停（B121）、`/goal` 暂停恢复（B95）、loop 账本（B94）                        | 已落地                  | AGENTS 常用命令表、`scripts/verify/stages/{task-next-steps,task-sigint,goal-pause,loop-ledger}.mjs`              |

> 所以本文的价值集中在**还没人做的部分**：统一账本与 `moss runs`（N2）、能力面板（N3）、`--until`/`--plan` 收进 `moss run`、以及 X1/X2/X3/X4/X5 的删除。

## 1. 能力清单表

### 1.1 代码质量分布（实测行数）

| 子系统                                     | 文件 |   行数 | 说明                            |
| ------------------------------------------ | ---: | -----: | ------------------------------- |
| `src/cli`（含 tui / commands）             |  165 | 57,551 | 38.8% 的代码在"表面"            |
| └ `src/cli/tui`                            |   32 | 12,754 | 只服务 1 个交互面               |
| `src/core/loop`（nudge / gate / steering） |   51 |  9,961 | 行为微调层                      |
| `src/core/superagent`                      |   19 |  4,162 | 可选子系统，1,146 行是 CLI 侧   |
| `src/core/subagent`                        |   12 |  3,270 |                                 |
| `src/core/task`                            |    9 |  3,014 | Task OS 内核                    |
| `src/core/mcp`                             |    6 |  3,002 |                                 |
| `src/core/skills`                          |   11 |  2,333 |                                 |
| `src/core/rsi`                             |    6 |  2,035 | SDK 导出，CLI 无入口            |
| `src/core/task-runtime`                    |    3 |  1,393 | 视图模型（TUI/CLI 读路径）      |
| `src/core/workflow`                        |    2 |    438 | 最年轻的引擎                    |
| `src/core/experience`                      |    1 |    368 | `MOSS_EXPERIENCE=1` 才开        |
| `src/core/capabilities`                    |    2 |    168 | 统一 registry（**无用户入口**） |

> 读法：CLI 层 57.5k 行 vs Task OS 内核 4.4k 行（task + task-runtime）。**表面比内核重 13 倍**，这是"能力很多但用户找不到"的结构性原因。

### 1.2 交互面 × 能力矩阵

图例：✅ 可用（有专用入口）／🟡 半成品（能用但缺关键环节／隐藏入口）／❌ 缺失。
每格证据见 §1.3。

| 能力                     | TUI                                   | REPL                         | headless（`-p` / `moss "x"`）                                           | SDK                                                                                  |
| ------------------------ | ------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **chat**                 | ✅ 全屏渲染 + 流式                    | ✅ readline                  | ✅ 单次 + `--output-format json/stream-json`                            | ✅ `MossAgent`                                                                       |
| **task（Task OS）**      | ✅ `/goal`（+Esc 暂停）、`/task` 隐藏 | ✅ 同上                      | ✅ `moss task run/resume/status/timeline/verify`                        | ✅ `runTask`/`resumeTask`/`TaskRuntime`                                              |
| **goal**                 | 🟡 只是 `/task run` 的糖              | 🟡 同上                      | 🟡 = `moss task run`（无独立 `goal` 概念）                              | 🟡 同 task                                                                           |
| **loop（跑→判定→再来）** | ❌                                    | ❌（`/loop` 已退役→`/goal`） | ✅ `moss loop --until`                                                  | ❌ 未导出                                                                            |
| **review**               | ✅ `/review`                          | ✅ `/review`                 | ✅ agent 可调 `review_changes`；`moss review check/list`                | 🟡 只有工具，无 CLI 层 API 导出                                                      |
| **device**               | ✅ 13 个工具，自然语言                | ✅ 同                        | ✅ 工具 + `moss device` + `moss tasks device`                           | ✅ 工具（经 agent 配置）                                                             |
| **skills**               | ✅ `/skills` + `/name` 别名           | ✅ 同                        | ✅ `skill` 工具 + `moss skill create/list/validate/install/update/lock` | 🟡 只能注入 `SkillCatalogPort`（`moss-agent-types.ts:231`），无 loader/registry 导出 |
| **MCP**                  | ✅ `/mcp`                             | ✅ 同                        | ✅ `moss mcp add/list/remove/test` + 工具                               | ❌ 无 MCP 客户端导出                                                                 |
| **subagent**             | ✅ 工具 + `/agents`                   | ✅ 同                        | ✅ 工具（deferred）                                                     | ✅ `src/core/subagent` 有导出                                                        |
| **memory**               | 🟡 `/remember`（只写）                | 🟡 同                        | 🟡 `moss remember`（只写）                                              | ❌ 无                                                                                |
| **verify**               | 🟡 `/task verify` 隐藏、无 `/verify`  | 🟡 同                        | ✅ `moss task verify` + exit 9 + `moss review check`                    | 🟡 verdict provider 有，无高层 API                                                   |
| **workflow（编排）**     | ❌                                    | ❌                           | ✅ `moss workflow run/resume/status/list`                               | ❌ `runWorkflow` 未从 `src/index.ts` 导出                                            |
| **superagent**           | ❌                                    | ❌                           | 🟡 `moss superagent init/submit/work/status`                            | 🟡 `createMossSuperagent` 有导出                                                     |

**三个不对称（都是产品问题，不是实现问题）**

1. **loop / workflow 在交互面完全不存在**：用户在最常用的 REPL/TUI 里无法发起"跑到测试通过"，只能退出到 shell 敲 `moss loop`。
2. **SDK 面 ≠ CLI 面**：SDK 导出了 task（`runTask`/`resumeTask`/`TaskRuntime`）与 agent loop，但**没有** skills / MCP / workflow / loop / capabilities 导出（实测 `dist/index.js` 过滤 `skill|mcp|review|workflow` 全为空）。嵌入者只能做 chat + task，CLI 用户却有 6 个引擎。
3. **memory 读写不对称**：写有 `/remember` + `moss remember`（追加 `## Remembered facts`，`src/cli/remember-command.ts:16`），读只有"新会话自动加载 AGENTS.md"，**没有 list/forget/diff**。

### 1.3 每个能力的真实入口清单（这是"重复"的事实基础）

| 能力            | 入口（数）                                                                                                                                                                                                                                   | 关键证据   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 发起 agent 运行 | **7 个名字 / 6 个实现**：`moss`/`moss "x"`、`moss task run`、`moss run`（=task run，B128）、`/goal`、`moss loop`、`moss workflow run`、`moss superagent work`；外加 1 个 env-only（`MOSS_GOAL_VERIFY_LOOP=1`，`src/cli/oneshot.ts:715-723`） | §2.1       |
| 判定"做完了"    | **4 类**：命令裁决（`--accept`/`--until`/`MOSS_GOAL_VERIFY_CMD`）、契约裁决（metric）、review verdict（`review.mode auto`）、完成闸门（4 连）                                                                                                | §2.5       |
| 看历史          | **4 套账本 + 6 个读命令**：`moss task list`、`moss task timeline`、`moss tasks *`、`moss loop list/show`、`moss workflow list/status`、`moss superagent status`                                                                              | §2.2、§2.3 |
| 恢复/继续       | **5**：`/goal resume`、`/task resume`、`moss task resume`、`moss loop`（重跑）、`moss workflow resume`；会话层另有 `--continue`/`--last`/`moss resume`/`moss fork`/`/resume`                                                                 | §2.4       |
| review          | **4**：`/review`、`review_changes` 工具、`moss review check/list`、`review.mode auto` 策略                                                                                                                                                   | §2.6       |
| verify          | **8**：`task_acceptance` 工具、`moss task verify`、`/task verify`、`verification` 闸门、`review_changes`、`moss review check`、`run_tests` 工具、exit 9                                                                                      | §2.5       |
| device 只读     | **4**：agent 工具（10 只读）、`moss device test`、`moss device fleet <probe>`、`moss tasks device`                                                                                                                                           | §2.7       |
| capability 列举 | **5**：`/skills`、`/agents`、`/rules`、`/mcp`、`moss skill list`（+ `moss plugins list`）；统一 registry 无入口                                                                                                                              | §2.8       |

---

## 2. 重复与重叠（每条给"用户什么时候会困惑"）

### 2.1 D1（最高）：六个 run 引擎、七个名字，名字看不出差别

| 引擎                   | 会话模型                                       | 判定                            | 预算/节奏                                                      | 账本                                     | 退出码           | 谁能触发       |
| ---------------------- | ---------------------------------------------- | ------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------- | -------------- |
| `moss "x"` / `-p`      | 单会话                                         | `MOSS_GOAL_VERIFY_CMD`（env）   | 1 次 continuation                                              | 无                                       | 0/9/…            | 所有人         |
| `moss run`（新，B128） | **= `moss task run` 的薄别名**（同一 handler） | 同 task run                     | 同 task run                                                    | 同 task run                              | 同 task run      | 所有人         |
| `moss task run`        | 单 Task OS 会话（plan→exec→verify→repair）     | `--accept` 命令 或 契约 verdict | `--max-repairs` `--max-turns`                                  | `.moss/goals.jsonl` + 5 个 Task OS jsonl | 0/1/130          | 所有人         |
| `/goal`（REPL/TUI）    | **= `/task run`（重写）**                      | 同上                            | 同上                                                           | 同上                                     | 会话内           | 交互用户       |
| `moss loop`            | **每 attempt 全新会话**                        | `--until` 命令                  | `--max` `--every` `--max-duration` `--watch` `--until-timeout` | `.moss/loops/<runId>.jsonl`              | 0 只来自检查命令 | 所有人         |
| `moss workflow run`    | 每 step 全新会话，DAG 依赖                     | 每步 exit code                  | 每步 `maxTurns`                                                | `.moss/workflows/<runId>/state.json`     | 步级             | 所有人         |
| `moss superagent work` | 每 ticket 一个 worker，内部调 `runTask`        | Task verdict                    | ticket 级                                                      | `.moss/superagent/state.sqlite`          | ticket 级        | 所有人         |
| （隐藏）`-p` + env     | 单会话 + 1 continuation                        | env 命令                        | 固定 1 次                                                      | 无                                       | 0/9              | 只能靠环境变量 |

**用户何时困惑**：

- 想让"测试绿了才算完"，敲 `moss loop --until "npm test"` 也行、`moss task run "..." --accept "npm test"` 也行——两者都能跑，但**前者每轮失忆、后者有记忆和状态机**，没人告诉用户该选哪个。
- 在 REPL 里读 `--help` 看到 `/loop` 已改成 `/goal`（README 旧版明写），于是以为 `loop` 就是 `goal`；结果真正的 `moss loop` 在 CLI 里是另一套东西，且交互面**无法调用**。
- 跑完一次 `moss loop` 之后想 resume：`moss loop` 没有 resume，只有 `moss task resume`——用户得先知道"loop 不能 resume，task 才能"。
- `moss workflow` 的 step 也是"全新会话 + exit code"，但它不产出 `.moss/goals.jsonl`，所以 `moss task list` 里看不到 workflow 的运行。

### 2.2 D2：`moss task` 与 `moss tasks` 只差一个字母

- `moss task`：Task OS（`run/resume/status/list/timeline/view/verify`，`src/cli/task-run.ts:164-186`）。
- `moss tasks`：机器人闭环产物只读巡检（`list/evidence/deployments/acceptance/device`，`src/cli/tasks-commands.ts:39-52`）。

**用户何时困惑**：想知道"我之前那些任务怎么样了"，输入 `moss task list` 得到的是**目标运行汇总**（`.moss/goals.jsonl`），输入 `moss tasks list` 得到的是**任务契约**（`tasks.jsonl`）——两个 `list` 都是"任务列表"，内容完全不同。命令表（旧 README 与拆分后的 `docs/cli-reference.md`）把两行并排放在同一张表里，但没有一句话说"什么时候用哪个"。

### 2.3 D3：同一批 `.moss/` 工件有两套读命令

`moss task view evidence|deployments|failures|history`（`task-run.ts:885-930`）与 `moss tasks evidence|deployments|failures|acceptance`（`tasks-commands.ts:112`）读的是同一批 jsonl，只是格式化不同。

**用户何时困惑**：`/evidence` `/deployments` `/failures` `/history` 这 4 个旧 slash 被 retired 到 `/task view *`（`interactive-commands.ts` `RETIRED_SLASH`），但 shell 里还有 `moss tasks evidence` 这条"另一个真名"。同一个人在 REPL 和 shell 里会学到两套名字。

### 2.4 D4：恢复语义有 5 个入口、3 种含义

| 入口                                            | 恢复什么                     | 证据                               |
| ----------------------------------------------- | ---------------------------- | ---------------------------------- |
| `/goal resume [id]`                             | Task OS 任务（可改验收命令） | `repl.ts:915-947`、`goal-pause.ts` |
| `/task resume` / `moss task resume`             | 同上（`/goal` 是它的糖）     | `task-run.ts:164`                  |
| `moss resume --last` / `--continue` / `/resume` | **会话**（对话历史）         | `args.ts`、`sessions`              |
| `moss fork` / `--fork-from`                     | 会话分叉                     | `args.ts`                          |
| `moss workflow resume`                          | workflow 未完成步骤          | `workflow-command.ts:55`           |
| `moss loop`（重跑）                             | 不恢复，重新开始             | `loop-command.ts`                  |

**用户何时困惑**："刚才那个任务断了怎么接着跑"——`resume` 有 5 个，一个恢复对话、一个恢复任务、一个恢复 DAG，还有一个干脆不恢复。

### 2.5 D5：verify 有 8 个入口，判定语义 5 种

| 入口                                | 判定什么                       | 退出码                          | 证据                                       |
| ----------------------------------- | ------------------------------ | ------------------------------- | ------------------------------------------ |
| `task_acceptance` 工具              | metric 对证据                  | 工具结果                        | `src/tools/task-tools.ts`                  |
| `moss task verify` / `/task verify` | 重跑一次 verdict，**不调模型** | 0/1                             | `task-run.ts:877`                          |
| acceptance 闸门                     | 本 run 定义过 task 但无裁决    | 拦一次                          | `acceptance-completion-gate.ts:196`        |
| verification 闸门（L1）             | 改了文件却没有任何检查         | 拦一次                          | `verification-completion-gate.ts:273`      |
| `review_changes` / `/review`        | 独立评审 findings              | 0/1/2（经 `moss review check`） | `review-tools.ts`、`review-commands.ts`    |
| `review.mode auto`                  | 有变更必须评审                 | 闸门                            | `config-commands.ts:655`                   |
| `run_tests` 工具                    | 测试命令                       | 工具结果                        | `src/tools/`                               |
| headless exit 9                     | 声称验证过但没真跑             | 9                               | `exit-codes.ts:15`、`run-outcome.ts:43-50` |

**用户何时困惑**：CI 里想"没验证就失败"，可以看 exit 9、可以 `moss review check`、可以 `moss task verify`——三者失败条件不同，文档没有一张对照表。

### 2.6 D6：review 有 4 个入口，且账本只有一份

`/review`（prompt 注入 → `review_changes` 工具）、`review_changes`（工具，agent 自己调）、`moss review check|list`（读 `.moss/review.jsonl`）、`review.mode auto`（策略强制）。四者写同一份 `review.jsonl`，这是**做对了**的部分；问题在"哪个入口在什么场景下用"没有任何文档。

**用户何时困惑**：`/review` 看起来像"评审我"；但 `review.mode auto` 打开后 agent 会自动评审，用户再敲 `/review` 就是重复评审（`review_changes` 用 diff 哈希标识"同一份变更"，`review-tools.ts:715` 的提示就建立在"改文件后哈希才变"上；但用户不知道第二次是空转）。

### 2.7 D7：device 只读有 4 条路径，探测项名字各不相同

- agent 工具：`device_info` / `device_processes` / … / `device_probe`（13 个）。
- `moss device test <id>`（连接测试）。
- `moss device fleet info|processes|resources|temperature|robotics|... --devices a,b --concurrency 4`（`device-commands.ts:521`）。
- `moss tasks device`（解析出的目标与连接状态）。

**用户何时困惑**：想"一次看三块板子的温度"，得知道 `moss device fleet temperature`；而在对话里说"看看三块板子的温度"，agent 会逐个调 `device_temperature`。同一个意图、两种答案格式。

### 2.8 D8：能力列举散在 5 个地方，而统一 registry 没有入口

`CapabilityKind` 已经统一成 5 类（`instruction` / `skill` / `command` / `agent` / `mcp_server`，`src/contracts/capability.ts:12`），`CapabilityRegistry` 已经有 `list(kind?)` 和 `activeForPaths()`（`src/core/capabilities/registry.ts:34,44`），`slash.ts` 甚至把 slash 优先级做成了数据。**但用户能看到的仍然是 5 个分散视图**：`/skills`、`/agents`、`/rules`、`/mcp`、`moss skill list`；`instruction` 类（AGENTS.md + `.moss/rules`）只在 `/rules` 里露一半。

**用户何时困惑**："我这个会话到底加载了什么、占多少 token、从哪来的"——这是 Claude Code `/context` 与 Cursor 能力面板都在回答的问题，Moss 有数据、没出口。

### 2.9 D9：模式/安全有 11 种表达；README 刚被重写，但"命令面 parity"仍无守护

模式面：4 个交互模式（`manual`/`acceptEdits`/`plan`/`full`，`interaction-mode.ts:10`）+ 3 个 `--read-only/--workspace-write/--full-access` 上限 + `--accept-edits` + `--ask-for-approval` + `--plan` + `Shift+Tab` + `/permissions` + `/mode`（hidden）+ config `profile` + 4 个 legacy env。11 种表达、2 个真概念（模式 + 上限），这是"名词语义过载"的典型。

**README 的现状（审计期间已修复大半）**：原 README（HEAD `ab9ad905`，470 行）有 4 处失真——45 个工具/12 个 device 工具（实为 51/13）、`moss task run --goal`（无此 flag）、`test/sdk-contract.spec.mjs` 快照（已删）、`plugins` 说成"已移除"（已实现）——以及命令参考表缺 8 个已实现命令（`loop`/`review`/`rules`/`remember`/`plugins`/`workflow`/`trust`/`superagent`）。**这几条在工作树里已被重写修掉**（见 §0.5）。

**仍然缺的**：`scripts/verify/readme-parity.mjs` 只锁了 7 件事（中日章节 1:1、200 行预算、链接可解析、工具数/build 一致、hero 命令存在、无内部工单号、语言互链），**没有锁"README/`docs/cli-reference.md` 的命令清单 == `KNOWN_COMMANDS`"**。也就是说：新加一个命令忘了写文档，仍然没有任何红灯。

### 2.10 D10：首个 5 分钟：`--help` 首屏 4 条、19 个可见 slash 里 9 个没进 README

- `moss --help` 的 "Most useful" 现在是 **4 条**（`moss` / `moss setup` / `moss "check this project"` / `moss run ... --accept`，工作树 B128）——方向对。
- 但 `--help --all` 才是完整 **21 个实现命令**——新用户默认看不到；且 4 条里 3 条是"发起"，**0 条是"看结果/看能力"**（`moss task status`、`moss runs`、`moss capabilities` 都不在首屏）。
- 首次运行 = 内联 setup（provider 选择 → key → 探测），代码 2,400 行（`first-run.ts` 836 + `onboarding.ts` 767 + `setup-wizard.ts` 636 + `onboarding-hints.ts` 161），**setup 结束后没有任何"下一步"提示**（`grep "next:"` 在 onboarding/first-run 无命中；`next:` 只在 `task run` 非通过时出现）。
- README 的"日常斜杠命令"列 10 个，实际可见 **19** 个：`/model /compact /goal /plan /review /doctor /diff /resume /paste /rules /remember /skills /agents /todos /permissions /language /theme /clear /help`（未列的 9 个：`/resume /paste /rules /remember /skills /agents /todos /language /theme`）。

**用户何时困惑**：装好、跑通一句 chat 之后，**没有任何东西告诉他 Moss 还有 task/loop/review/workflow/capabilities**。这是"能力过剩但留存低"的直接机制，也是本次审计认为比任何单点 bug 都值得修的一条。

---

## 3. 删除候选与新增候选

### 3.1 删除候选（按 价值/风险 排序；每条给替代路径 + 风险）

**X1 — 删除 `moss tasks` 子命令组（`list/evidence/deployments/acceptance/device`）**

- 证据：`src/cli/tasks-commands.ts:39-52`；与 `moss task view *`（`task-run.ts:885`）读同一批工件。
- 替代路径：`moss task view tasks|history|evidence|deployments|failures`；`moss tasks device` → `moss device list` + `moss device test`。
- 价值：顶层动词 -5、少一套格式化与一套 i18n 文案、D2/D3 两条困惑直接消失。
- 风险：**低**。只读命令、无 SDK 面；风险仅在"用户脚本里 grep 过 `moss tasks` 输出"。迁移：保留一版 alias（打印 "`moss tasks` is now `moss task view`" 并转发）。
- 不做会怎样：两个只差一个字母的顶层命令会一直在。

**X2 — 删除 `MOSS_GOAL_VERIFY_LOOP` / `MOSS_GOAL_VERIFY_CMD`（env-only 第 4 引擎）**

- 证据：`src/cli/oneshot.ts:715-723`（首轮非零 → 仅一次 continuation）；只出现在 `moss config env` 文档（`config-commands.ts:354-355`），README 从未提及。
- 替代路径：`moss loop --until "<cmd>"`（同语义 + 账本 + 预算 + `--watch`），或 `moss task run --accept`（有状态机）。
- 价值：删掉一个藏在环境变量后的运行引擎与一套 `verify_failed` 特判；`RunOutcome` 的 5 状态可以简化为 4。
- 风险：**中**（有 CI 脚本可能依赖；且 `--until` 的语义是"新会话每轮"，env 版是"同一会话续一轮"，行为不等价）。迁移：先告警一个 minor，再删；需要"同会话续跑"能力的话，用 `moss task resume --accept` 表达。

**X3 — 删除 `moss device fleet <probe>`**

- 证据：`src/cli/device-commands.ts:521`；`fleet` 有 **9 个探测项别名**（info/processes/resources/temperature/robotics/network/cameras/file_read/file_list，`device-commands.ts:28-30`）与 agent 工具一一对应；`--devices`/`--concurrency` 两个专用 flag。
- 替代路径：`moss device test <id>` 逐台；对话里让 agent 用 `device_probe`/`device_temperature`；批量用 `moss device list` + 一次对话。
- 价值：device 只读路径 4 → 3；少 9 个探测项别名与 2 个 flag。
- 风险：**低-中**（README 的"四条命令做多机巡检"是卖点之一）。若不想删，退一步：把它并进 `moss device test --all --probe <kind>`，共享同一套参数解析。

**X4 — 删除 `moss update` 与 4 个别名（`install`/`login`/`upgrade`/`logout`）**

- 证据：`moss update` 只打印升级命令、不执行（`--help --all` 自述 "print the upgrade command"）；别名是历史兼容层。
- 替代路径：`moss doctor` 已报版本与升级提示；README「升级」「卸载」章节给的是 npm 命令。
- 价值：顶层动词 -1、别名表 -4，减少"moss 能自己升级吗"的误解（它不能）。
- 风险：**低**。`moss logout` → `moss auth logout` 需要一版 alias 提示。

**X5 — 删除 `migrate` / `web` / `agent` 三个占位命令**

- 证据：`UNIMPLEMENTED_COMMANDS = ['migrate','web','agent']`（`command-dispatcher.ts`），命中即硬失败；`subcommand-help.ts` 还为它们各写了一段"本构建没有此子系统"的文案，并占着 `CliCommand` 类型位。
- 替代路径：未知命令统一报错 + `moss --help`；若需要解释，放在 `moss doctor` 的"removed subsystems"一行。
- 价值：少 3 个类型位 + 3 段 help + 3 个"看起来存在"的名字（这正是旧 README L332 失真的来源，已随重写修掉）。
- 风险：**极低**（行为从"明确报错"变"未知命令"；可在 unknown-command 提示里补一句"`plugins` 现在是本地能力包，`web/agent/migrate` 已移除"）。

### 3.2 新增候选（按 价值/风险 排序）

**N1 — `moss run`：一个 run 动词（价值最高、风险最高）**

```text
moss run "<task>"                          # 单次任务（= 今天的 moss task run，无 --accept 时走契约/证据裁决）
moss run "<task>" --until "npm test"       # 闭环（= 今天的 moss loop --until；每轮新会话）
moss run "<task>" --accept "<cmd>"         # 目标+命令裁决（= /goal 的语义）
moss run --plan .moss/workflows/audit.json # 多步依赖（= 今天的 moss workflow run）
moss run --resume <runId>                  # 恢复（统一 task resume / workflow resume）
moss run --json                            # 机器可读（输出统一 run 记录）
```

- 为什么是根因：把"6 个引擎"收敛成"1 个动词 + 3 个修饰符（`--until` / `--accept` / `--plan`）"，用户只需要理解一句"run 会一直跑到你的命令通过"。
- 现状：工作树**已落地最小版**（`moss run "<intent>" --accept "<cmd>"` = `task run`，B128）；本文建议的增量是把 `--until`（loop）与 `--plan`（workflow）也收进同一入口，否则名字多了、引擎没少。
- 复用：`runTask`（单任务）、`loop-command` 的 attempt 循环、`runWorkflow` 的波次调度三者都是现成的；`--until` 与 loop 完全同构，`--plan` 与 workflow 同构。
- 风险：**高**——涉及 3 套账本合并、superagent worker 内部调用 `runTask`、bench（`bench/tasks/task-os-*`）与 verify 探针。必须分阶段（§4.5）。

**N2 — `moss runs`：统一账本读路径**

```text
moss runs list [--status pass|fail|blocked|aborted|running] [--json]
moss runs show [<id>|latest] [--json]     # 每 attempt：会话、退出码、判定、闸门 kind/reason
moss runs export <id> --format json|md    # 交给 CI/PR
moss runs prune --keep 50 [--dry-run]
```

- 为什么：今天 4 套账本（`goals.jsonl` / `loops/*.jsonl` / `workflows/*/state.json` / `superagent/state.sqlite`），用户要记 4 个读命令。统一 schema 建议 `moss_run.v1`：`{id, kind: 'task'|'loop'|'workflow'|'superagent', parentId?, attempts: [{n, sessionKey, exitCode, verdict, gate?, startedAt, endedAt, outputTail}], outcome: RunOutcome}`。
- 复用：`RunOutcome`（`src/cli/run-outcome.ts:43-50`）已经定义了 5 个终局状态与退出码映射；`moss task list --json`（`task-run.ts:800`）的投影逻辑是现成的行格式化器。
- 风险：**中**（双写期需要一致性测试；`.moss/` 工件格式对用户是可见的）。

**N3 — `moss capabilities` / `/capabilities`：一个面板**

```text
moss capabilities [--kind instruction|skill|command|agent|mcp_server] [--json]
  kind  name  scope(workspace|user|managed|plugin)  activation(always|globs|description|manual)  cost(chars)  source(path)
```

- 为什么：`CapabilityRegistry.list(kind?)` + `activeForPaths()` 已实现（`registry.ts:34,44`），**零新概念**；今天用户要 5 个命令才拼得出一张表。
- 复用：`/skills` 已显示 "scope / real usage / catalog cost / evals"（见 `--help --all`），`/rules` 已显示 activation class；把两者字段合并即可。
- 风险：**低**（纯读路径）。

**N4 — 首个 5 分钟：`next:` 行 + `moss doctor --next`**

- 内容：首次 setup 完成后、以及每次 run 结束（非 pass）时，打印 **1-2 行**下一步，例如
  `next: moss run "make the tests pass" --until "npm test"` / `next: moss capabilities`
- 为什么：今天 setup 结束即空提示符；`--help` 首屏 4 条里 0 条是"看结果/看能力"；这是留存的第一道门。
- 复用：`onboarding-hints.ts` 已有 hint 机制（161 行），`moss task list` 的非通过 summary 已有 "next:" 文案模式（B119）。
- 风险：**低**（文案 + 一次 `--next` 参数）；风险在"提示要准"——不能推荐用户当前环境做不到的命令（如无 git 仓库时推 `/review`）。

**N5 — `moss remember --list / --forget`（读写对称）**

- 现状：`/remember` 与 `moss remember` 只能追加到 AGENTS.md 的 `## Remembered facts` 小节（`remember-command.ts:16`，500 字上限、去重、`--dry-run`）；没有 list/forget。
- 新增：`moss remember --list [--json]`（列出该小节条目 + 行号）、`moss remember --forget <n|text>`（删一条 + diff 预览）。命名上**不新增 `moss memory` 顶层动词**，避免又加一个词。
- 风险：**低**（纯文件读写，已有 `buildRememberPlan` 可复用）。
- 备注：跨会话自动记忆仍是 owner 冻结项（AGENTS.md 明写"不做自动写入"），本项不触碰。

---

## 4. 根因方案：重做 run 生命周期 + 首个 5 分钟

### 4.1 三条设计原则

1. **一个对象：run。** 今天"task / goal / run / loop / workflow / ticket"是 6 个用户词、7 个名字（`moss run` = `task run`）；它们本质是同一个东西：**一次 run = 一个意图 + 一个判定 + 一份账本**。差异应表达为**修饰符**（`--until` / `--accept` / `--plan`），不是新命令。
2. **判定只有两种来源：外部命令，或契约证据。** 模型散文永远不是判定（这条 Moss 做对了，要保留并统一）。review 是**可选的第三层**（`review.mode`），且它的结果也是一种判定记录，不是新引擎。
3. **终局要落盘。** 每次 run 结束时，把"为什么停"写成一条结构化记录（`RunOutcome` + 闸门 `kind/reason`）。今天的闸门已经产出结构化原因，但没有第二个人能读到。

### 4.2 目标命令面（保留 / 合并 / 删除）

| 层   | 保留                                                                                                      | 合并                                                                         | 删除                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 交互 | `moss`（TUI/REPL 一套命令）、`/run`、`/review`、`/compact`、`/resume`、`/rewind`、`/diff`、`/permissions` | `/goal` → `/run`；`/loop` 别名 → `/run --until`；`/task` 隐藏入口保留一版    | 17 个 hidden 与 10 个 retired 里的 `/mode` `/steer` `/queue`（到期即删） |
| run  | 保留内核：Task OS 状态机、`runTask`、loop attempt 循环、workflow 波次                                     | **`moss run` 统一入口**（`--until`/`--accept`/`--plan`/`--resume`/`--json`） | `MOSS_GOAL_VERIFY_LOOP`；`moss update`；`migrate/web/agent`              |
| 读   | 保留 `moss doctor`、`moss config`、`moss sessions`、`moss device`、`moss mcp`                             | **`moss runs`**（4 套账本 → 1 套）；`moss tasks` → `moss task view`          | `moss device fleet`                                                      |
| 扩展 | 保留 `moss skill`、`moss plugins`、`moss rules`、`/remember`                                              | `moss capabilities`（统一面板）                                              | —                                                                        |
| 编排 | 保留 `moss workflow` 的**计划格式**（JSON + dependsOn）                                                   | workflow 变成 `moss run --plan` 的实现                                       | superagent 降级为可选扩展（不进主命令面）                                |

**目标顶层动词：26 → 20**（删 `tasks`/`update`/`migrate`/`web`/`agent`，加 `runs`/`capabilities`）：`moss` / `run` / `runs` / `task`（兼容一版） / `review` / `resume` / `fork` / `sessions` / `config` / `setup` / `auth` / `doctor` / `device` / `mcp` / `skill` / `plugins` / `rules` / `remember` / `capabilities` / `workflow`（兼容一版） / `trust` / `uninstall`（22 个，另 `loop`/`tasks` 保留一版转发后删）。

### 4.3 一个 run 的生命周期（目标状态机）

```text
            ┌──────────────── admit ────────────────┐
            │ 解析意图：--until | --accept | --plan   │
            │ 冻结预算：maxAttempts/maxTurns/maxWall   │
            └───────────────────┬───────────────────┘
                                ▼
   attempt 1..N:  ┌──────────── 会话 ────────────┐
                  │ fresh（loop/workflow/until）   │
                  │ 或 carry（task 的修复回合）     │
                  └──────────────┬───────────────┘
                                 ▼
                  ┌────────── 判定 ──────────┐
                  │ 1 外部命令（必选其一）     │
                  │ 2 契约/证据（task）        │
                  │ 3 review（可选策略）       │
                  └──────────┬───────────────┘
                             ▼
        ┌────────── 终局（写 run.json）──────────┐
        │ outcome: completed | incomplete |      │
        │          verify_failed | blocked |     │
        │          unverified                    │
        │ gate:    missing-review | review-fail |│
        │          unverified-change | no-verdict│
        │          | unrepaired-fail | background│
        └──────────┬─────────────────────────────┘
                   ▼
        exit code（0 / 1 / 9 / 130） + `next:` 行 + `moss runs show`
```

**关键改动**：把 completion gate 从"4 个匿名拦截器"变成"**一个终局裁决器**"——4 个闸门各自返回 `{kind, reason, correction}`（今天 acceptance/verification 已有 `kind`，plan/background **还没有**，需补齐，`plan-completion-gate.ts:105`、`background-lifecycle-gate.ts:31`），裁决器按固定优先级取第一个 `ok:false` 的 `kind` 写进 `run.json.gate`，同时 `correction` 只注入一次（今天最多可能连拦 4 次，每次一个新回合）。

### 4.4 首个 5 分钟（目标体验，4 步）

```bash
moss                                  # 首次：6 个 provider 预设（deepseek/qwen/openai/anthropic/openai-compatible/d-robotics）→ key → 探测 → 直接进入对话
moss run "fix the failing unit test" --until "npm test"
moss runs show latest                 # 为什么停：attempt 1 失败原因 + 检查输出尾部 + next:
moss capabilities                     # 我这个会话能加载什么、各占多少 token
```

设计要点：

1. **不要求用户先学 6 个引擎**——`moss --help` 的 "Most useful" 现在 4 条全是"发起"（`moss`/`moss setup`/`moss "x"`/`moss run --accept`）；建议至少换进 1 条"看结果/看能力"（`moss runs show latest` 或 `moss capabilities`）。
2. **失败即教学**：run 非通过时打印 `next:`（重试 / resume / 看账本），而不是只打印 exit code。
3. **能力可见**：`moss capabilities` 回答"为什么 agent 知道这条规则/这个 skill"（今天要 5 个命令）。
4. **第一次 run 就用外部命令判定**：让"完成"的定义从第一分钟就是可机检的——这是 Moss 相对普通 coding agent 的唯一差异化，必须在 5 分钟内被看到。

### 4.5 迁移代价（分三期，含破坏面与验证）

| 期               | 内容                                                                                                                                                                                                          | 破坏面                                                          | 验证方式                                                                                                                                                                                     | 估时   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P0（1-2 天）** | ① `RunOutcome` 落盘到 `.moss/runs/<id>/run.json`（loop/workflow/task 各自写）② 给 plan/background 闸门补 `kind` ③ `moss runs list/show` 读统一目录（兼容读旧账本）                                            | 无（只新增写盘 + 新读命令）                                     | `moss loop`/`task run` 各跑一次，`moss runs show latest` 能回答 outcome+gate；`node scripts/verify/cli.mjs --stage loop-ledger,goal-runs,task-status`（fast gate 现 76 stage，已有对应探针） | 1-2 天 |
| **P1（3-5 天）** | ① `moss run` 补齐 `--until/--plan/--resume`（`--accept` 已随 B128 落地，内部路由到现有三套实现）② `/goal` → `/run`，`/loop` 别名 → `/run --until` ③ `moss capabilities`                                       | `moss task run`/`loop`/`workflow` 变成 deprecated alias（一版） | 三套各自 e2e：`bench/tasks/task-os-{a,b,c}` + `--stage loop-command,workflow` 探针 + `--json` 快照                                                                                           | 3-5 天 |
| **P2（2-3 天）** | ① 三套账本合并为单一实现（workflow 变 `--plan` 的执行器；loop 变 `--until` 的执行器）② 删除 X1-X5 ③ README/AGENTS 命令面重写 ④ `--help` 首屏加"看结果/看能力"（`moss runs show latest`、`moss capabilities`） | 删命令 + 删 env + 删 `moss tasks`（保留一版 alias 转发）        | 同 P1 + `moss --help --all` 快照 + 扩展 `readme-parity` 增加"命令表 == `KNOWN_COMMANDS`"一项                                                                                                 | 2-3 天 |

**明确不做**（避免过度设计）：

- 不引入新的 daemon / server / 托管 registry（AGENTS 边界）；
- 不把 superagent 塞进主命令面（保留为可选扩展，`moss superagent` 或 `moss plugins` 形态）；
- 不动 TUI 的渲染层（12,754 行与本次问题无关）；
- 不做自动记忆写入（owner 冻结）；
- 不重写 51 个工具的名字（device 工具名是契约）。

### 4.6 一句话回答"如果重做，保留/合并/删除什么"

- **保留**：Task OS 状态机 + 命令裁决（这是护城河）、`review_changes` + `.moss/review.jsonl`、capability registry、TUI/REPL 一套命令表、device 工具、`/rewind` checkpoint。
- **合并**：6 引擎 → `moss run`（3 修饰符）；4 账本 → `moss runs`；4 套 completion gate → 1 个终局裁决器；`moss tasks` → `moss task view`；5 个能力列举 → `moss capabilities`。
- **删除**：env-only loop、`moss update`、`migrate/web/agent` 占位、`moss device fleet`、到期的 hidden/retired slash 别名。

---

## 5. 风险与未验证

### 5.1 风险

| #   | 风险                                                                                                                              | 触发  | 缓解                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `moss run` 收敛会破坏已有脚本与 CI（`moss task run`/`loop`/`workflow` 的 exit code 与 stdout 被 bench、superagent、用户脚本依赖） | P1/P2 | 一版 deprecated alias；保持 exit code 表不变；先双写账本、后切入口                                                              |
| R2  | 4 套账本合并会产生"旧账本读不到"或"双写不一致"                                                                                    | P2    | 统一 schema 带 `schema:'moss_run.v1'` + 读侧兼容；不一致时以新为准并告警（不静默）                                              |
| R3  | completion gate 合并成裁决器会改变"被拦几次"的行为（今天可能连拦 4 次）                                                           | P0    | 这是**有意的行为修正**；需在 bench 的 hard 层对照"拦截次数/完成率"，并保留 `MOSS_DISABLE_NUDGES` 式开关                         |
| R4  | 删除 `MOSS_GOAL_VERIFY_*` 会打破"同会话续跑"的现有用法                                                                            | X2    | 先告警一个 minor；把等价能力表达为 `moss task resume --accept`                                                                  |
| R5  | `moss capabilities` 展示的 token 成本可能不准（estimated vs actual）                                                              | N3    | 标注 estimated；与 `/context` 口径统一后再接真值                                                                                |
| R6  | superagent 与 `moss run` 的关系若不定清，会再留下一个引擎名（`moss run` 本身是别名，不是第 7 个实现）                             | P1    | 明确其为 `moss run` 的"ticket 前端"，内部统一调 `runTask`（今天已经是）                                                         |
| R7  | 文档失真会持续误导新用户（**已部分落地**：README 重写 + `readme-parity` 探针 7 项；**仍缺**"命令表 vs `KNOWN_COMMANDS`"这一项）   | 立即  | 在 `scripts/verify/readme-parity.mjs` 加第 8 项：从 `KNOWN_COMMANDS` 取集合，断言 README + `docs/cli-reference.md` 提到每个命令 |

### 5.2 未验证（`[unknown]`）

| #   | 项                                                                                     | 为什么没验证                                      |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| U1  | 6 个引擎的真实使用率（哪个真的有人在用）                                               | 需要遥测；`MOSS_TELEMETRY_ALLOW` 默认关；本次不跑 |
| U2  | `moss loop` / `task run` / `workflow` 的终局语义在长跑下的差异（拦截次数、恢复成功率） | 需真实 provider 跑长任务；本次禁跑                |
| U3  | 首个 5 分钟的真实流失点（setup 后 drop-off）                                           | 需要用户数据 `[unknown]`                          |
| U4  | `moss superagent` 是否已有外部用户                                                     | 仓库内只有 spec/bench；`[unknown]`                |
| U5  | `moss review check` 在 CI 里的采用情况                                                 | 需外部仓库数据 `[unknown]`                        |
| U6  | 合并 6 引擎后 bench 分数是否变化                                                       | 需跑 `bench/tasks/task-os-*`；本次禁跑            |
| U7  | 17 个 hidden slash 是否还有人在用（决定何时删）                                        | 需遥测 `[unknown]`                                |

### 5.3 给 Lead 的执行建议（按投入产出，已扣除 §0.5 已在飞的部分）

1. **今天（0.5 天，零风险）**：
   - `moss runs` 的 P0 —— `RunOutcome` 落盘 + `moss runs show/list`（复用现有 `RunOutcome` + 闸门 `kind`，见 §4.3）；
   - `moss capabilities`（`CapabilityRegistry.list()` 已有，只差一个 CLI 出口）；
   - 给 `readme-parity` 加第 8 项"命令表 == `KNOWN_COMMANDS`"（R7）。
2. **本周**：`moss run` 补齐 `--until` / `--plan` / `--resume`（`--accept` 已落地）＋ `/goal` → `/run` ＋ loop/workflow 的 `next:` 行。
3. **排期**：P2 三套账本合并 + X1-X5 删除（每项一版 alias + 一条 stage）。
4. **不要现在做**：superagent 主命令面化、TUI 改造、memory 自动写入、`moss tasks` 之外的任何"再想一个新名字"。
