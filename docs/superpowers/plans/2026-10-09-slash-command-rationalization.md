# 斜杠指令：对齐 Claude Code / Codex，能不做斜杠就不做（v0.31，修订版 v3）

> 日期：2026-10-09。状态：规划，未改代码。取代同日 v1/v2。
> 本版的两条硬规则（来自产品负责人）：
> **R1 同名或同义的命令，名字与语义一律跟 Claude Code（CC）/ Codex 一致，moss 不另取名。**
> **R2 在 CC/Codex 里不需要斜杠就能做到的事（打字、按键、自然语言、内置行为），moss 也不设斜杠，改成内置能力。**
>
> 证据口径：`CC 文档` = code.claude.com/docs/en/commands 与 /slash-commands；`Codex 源码` = openai/codex `codex-rs/tui/src/slash_command.rs`、`chatwidget/input_queue.rs`；`源码:行` = moss 仓库；`PTY 实测` = `MOSS_NO_TUI=1 node dist/cli.js` 经伪终端驱动。未核对项集中在 §9。

## 0. TL;DR

- 按 R1/R2 重审后：**21 个现有入口中，11 个与 CC/Codex 同名同义（保留）、5 个语义与主流冲突（必须改）、6 个 moss 自造名（并入主流名或变成内置行为）**，另有 2 个本来就不该存在（`/log`、`/quickstart`）。
- 三个最关键的改动：
  1. **`/steer`、`/queue`、`/stop` 取消斜杠**：CC/Codex 里"运行中再发一条消息"就是纠偏（Codex 对应 `turn/steer`），中断是 `Esc`。moss 现在却要用斜杠，还把普通消息默认排队到本轮结束后才处理——与主流行为不同。
  2. **三处语义冲突**：moss `/tasks`（Task OS 工件）vs CC `/tasks`（后台工作）；moss TUI `/resume`（恢复 Task OS 任务）vs CC/Codex `/resume`（恢复会话）；moss `/loop`（任务别名）vs CC `/loop`（按间隔重复）。
  3. **`/mode` 是 moss 自造名**：CC/Codex 均无。模式切换改由 `Shift+Tab`（已有）、`/plan`、`/permissions` 承担。
- 仍保留的 moss 独有入口只有 `/task`（Task OS 的 status/timeline/resume/view，隐藏；日常入口是与 CC/Codex 同名的 `/goal`）。
- 实施仍分 **P0 修缺陷 → P1 对齐改名与内置行为 → P2 完成率特性（A/B 把关）**，每项带文件、改法、验收命令与期望输出（§5–§8）。

## 1. 已核对的主流基线

### 1.1 Claude Code（`code.claude.com/docs/en/commands`）

- 内置命令名清单中**没有** `/mode`、`/steer`、`/queue`、`/sessions`、`/jobs`、`/bg`、`/subs`、`/log`、`/quickstart`、`/evidence`、`/failures`、`/deployments`、`/history`。
- 别名：`/clear` = `/reset` `/new`；`/rewind` = `/checkpoint` `/undo`；`/usage` = `/cost` `/stats`；`/tasks` = `/bashes`；`/review` = `/code-review` 的别名。
- `/plan [描述]`：进入 plan 模式，带描述则立即开始。
- `/goal [条件|clear]`：持续工作直到条件满足；`clear/stop/off/reset/none/cancel` 取消。
- `/tasks`：查看与管理**当前会话的后台工作**（含已结束的子代理）。`/stop`：停止所连的**后台会话**（不是打断当前回复）。
- `/resume [会话]`：恢复**对话**（ID/名称/选择器）。
- `/loop [间隔] [提示]`：按间隔重复运行（bundled skill）。`/verify`：用户显式触发的 skill（构建并运行应用观察结果）。
- 运行中输入：回复进行时发命令会被**排队到本轮结束后**，但 `/status /tasks /usage` 等**立即执行**；skills 与自定义命令统一（`.claude/commands/x.md` 与 skill 都生成 `/x`）。

### 1.2 Codex（`slash_command.rs`）

- 枚举含：`Plan Goal Review Compact Resume Fork Init Clear New Diff Status Permissions Model Mcp Skills Hooks Export Copy Stop Ps Side Agents …`；**无** `/mode`、`/steer`、`/queue`、`/sessions`。
- `available_during_task()`：**false** = `Plan Review Compact Init Clear New Fork Export Cd …`；**true** = `Goal Stop Status Diff Model Permissions Skills Hooks Mcp Usage Ps Resume Side Quit …`。
- `/permissions`："choose what Codex is allowed to do"（选批准模式）。`/stop`、`/ps`：停止/列出**后台终端**。
- steer：`codex-rs/core/.../turn_input.rs` `steer()`、TUI `pending_steers`/`rejected_steers_queue`——**steer 是"运行中提交消息"的内置行为**，被拒绝（如 `/review`、手动 `/compact` 这类不可 steer 的回合）时回退到队列；**不是斜杠命令**。

### 1.3 冲突时的仲裁规则

两者都有但语义不同时：以 CC 为主（有逐条文档），Codex 名字作为**别名**加入（前提是不与既有名冲突）。例：后台工作列表主名 `/tasks`、别名 `/ps`。

## 2. 逐命令决策表（当前 21 个用户入口 + 目录外的已分发项）

状态码：**=** 与主流同名同义，保留；**≠** 语义冲突，必须改；**→** moss 自造名，并入主流名；**⇢** 取消斜杠，改内置行为；**✕** 删除。

| moss 现状                                                                                                                                                            | CC / Codex 对应                                  | 码                | 决策                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model` `/compact` `/clear` `/diff` `/help` `/mcp` `/skills` `/hooks` `/export` `/init`† `/review` `/doctor` `/context` `/usage` `/status` `/permissions` `/rewind` | 均有                                             | **=**             | 保留；见别名补齐（§6 P1-1）。†`/init` 现为死命令，见 P0-1                                                                                                                                        |
| `/plan`                                                                                                                                                              | CC `/plan [描述]`；Codex `/plan`                 | **≠**             | 现为 `/mode` 别名，无参只打印帮助（PTY 实测）。改为真正进入 plan 模式，带描述即开始（P0-2）                                                                                                      |
| `/mode`                                                                                                                                                              | CC/Codex **无**                                  | **→**             | 从菜单与 `/help` 移除。切换由 `Shift+Tab`（已有）、`/plan`、`/permissions` 承担；`/mode` 暂留隐藏别名并提示迁移，一个版本后删除                                                                  |
| `/goal`                                                                                                                                                              | CC `/goal`；Codex `/goal`                        | **=**（但被隐藏） | 取消 hidden，成为**唯一日常的"做到为止"入口**，语义跟 CC：`/goal <条件>`、`/goal clear`（P0-5）                                                                                                  |
| `/loop`                                                                                                                                                              | CC `/loop` = 间隔重复                            | **≠**             | 删除；迁移提示指向 `/goal`（P0-4）                                                                                                                                                               |
| `/task`（`run/resume/status/timeline/view`）                                                                                                                         | 无                                               | moss 独有         | 保留但**隐藏**，仅作 Task OS 高级入口；`run` 由 `/goal` 取代，菜单不再出现                                                                                                                       |
| `/resume`（TUI：恢复 Task OS 任务）                                                                                                                                  | CC/Codex = 恢复会话                              | **≠**             | `/resume` 改为恢复**会话**（复用 `moss resume` 的 TUI 内会话选择器，`cli-main.ts:476` 已有）；恢复任务改用 `/goal`（续跑）或隐藏的 `/task resume`（P0-7）                                        |
| `/sessions`                                                                                                                                                          | CC/Codex 无（由 `/resume` 选择器承担）           | **→**             | 并入 `/resume`；`/sessions` 仅保留隐藏别名                                                                                                                                                       |
| `/tasks`（Task OS 任务列表）                                                                                                                                         | CC `/tasks` = 后台工作                           | **≠**             | `/tasks` 改为后台工作/子代理列表（别名 `/ps`）；Task OS 任务列表并入 `/task view`（P0-8）                                                                                                        |
| `/jobs` `/bg` `/subs`                                                                                                                                                | CC `/tasks`；Codex `/ps` `/agents`               | **→**             | 全部并入 `/tasks`（别名 `/ps`），旧名仅隐藏别名                                                                                                                                                  |
| `/history` `/evidence` `/deployments` `/failures`                                                                                                                    | 无                                               | **⇢**             | 取消顶层斜杠。它们是 `.moss/*.jsonl` 的只读视图：保留 `/task view <kind>` 与 `moss tasks <kind>`（CLI），日常靠自然语言让 agent 读取（R2）。旧名一版内保留隐藏别名                               |
| `/steer`                                                                                                                                                             | 无；Codex 为"运行中提交消息"                     | **⇢**             | 运行中直接发消息即 steer（P1-2）；`/steer` 保留隐藏别名一版                                                                                                                                      |
| `/queue`                                                                                                                                                             | 无（CC/Codex 为内置队列行为）                    | **⇢**             | 队列行为内置：运行中发的消息显示在输入区上方，`↑` 取回编辑；`/queue` 保留隐藏别名一版（P1-2）                                                                                                    |
| `/stop` `/abort`                                                                                                                                                     | CC/Codex `/stop` = 停后台会话/终端；中断靠 `Esc` | **≠ ⇢**           | 打断当前运行 = `Esc`（已有）。`/stop` 不再表示"打断"：改为与 CC/Codex 同义（停后台工作），能力用现有 `exec_stop`（`src/tools/background-exec.ts`）实现；日常也可自然语言说"停掉那个服务"（P1-3） |
| `/quit`                                                                                                                                                              | CC `/exit`；Codex `/quit` `/exit`                | **=**             | 保留（两者名都支持）                                                                                                                                                                             |
| `/log`                                                                                                                                                               | 无                                               | **✕**             | 删除（v2 精简已去菜单，价值并入 `/doctor`）                                                                                                                                                      |
| `/quickstart`                                                                                                                                                        | 无                                               | **✕**             | 删除（内容与 `/status`、首启引导重复，v2 精简已判定）                                                                                                                                            |
| 目录外已分发：`/tui`                                                                                                                                                 | CC `/tui`；Codex `/tui`                          | **=**             | 保留                                                                                                                                                                                             |

汇总：**=** 约 18、**≠** 5（`/plan` `/loop` `/resume` `/tasks` `/stop`）、**→** 4（`/mode` `/sessions` `/jobs·/bg·/subs` 三合一视为一项）、**⇢** 3 类（`/steer` `/queue` + 工件视图）、**✕** 2。

## 3. 内置能力清单（R2：取代斜杠的"方便用的能力"）

| 能力                               | 取代                            | 主流依据                                           | moss 现状                                                                                                                                      | 要做                                                                                                                                          |
| ---------------------------------- | ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行中发消息 = steer，被拒绝则排队 | `/steer` `/queue`               | Codex `steer()` + `rejected_steers_queue`；CC 排队 | 运行中的普通消息**只排队到本轮结束**（`tui/app.ts:2082-2086`）；steer 只能走 `/steer`（`agent.steer?.(sessionKey, text)`，`app.ts:2002-2015`） | 默认走 `agent.steer`，返回 null/拒绝时回退到队列；队列在输入区上方可见、`↑` 取回（P1-2）。具体用哪个键"强制排队"见 §9-1（Codex 的键位未核对） |
| `Esc` 打断                         | `/stop`                         | 两者均如此                                         | 已有                                                                                                                                           | 无                                                                                                                                            |
| `Shift+Tab` 循环模式               | `/mode`                         | CC 同                                              | 已有                                                                                                                                           | 菜单/帮助中以此为主说明                                                                                                                       |
| `!` 命令、`@` 文件                 | `/run`、文件提及命令            | 两者均有                                           | 已有                                                                                                                                           | 无                                                                                                                                            |
| 会话选择器                         | `/sessions`                     | CC/Codex `/resume`                                 | `moss resume` 在 TTY 有选择器（`cli-main.ts:476`），TUI 内 `/resume` 却是 Task OS                                                              | 复用该选择器（P0-7）                                                                                                                          |
| 自然语言查工件/停进程              | `/evidence` `/failures` `/stop` | CC 全靠自然语言                                    | agent 本就有 `read_file`、`exec_stop`、`exec_logs`                                                                                             | 在系统提示的"工件位置"一句里写明 `.moss/*.jsonl` 含义，确保问"为什么失败"能直接读到 `failures`/`evidence`（P1-4，待核对现有提示是否已含）     |
| 文件化自定义命令 = skill           | `/skills` 之外的另一套          | CC "commands merged into skills"                   | TUI 不加载 `.moss/commands`；TUI skill 调用丢参数                                                                                              | 统一解析（P0-3）                                                                                                                              |

## 4. 用户交互原则（取舍判据）

| #   | 原则                                                                                                                                                                                                               | 判定办法                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| U1  | 名字语义跟 CC/Codex，不自造（= R1）                                                                                                                                                                                | §2 表中无 **→**、**≠** 残留                                                                               |
| U2  | 菜单里有的，键入就能用，且在 REPL 与 TUI 都能用                                                                                                                                                                    | spec：目录每行在两界面 dispatch 不得返回 unknown/not available                                            |
| U3  | 能不用斜杠就不用（= R2）：中断、纠偏、队列、模式、会话切换都有内置路径                                                                                                                                             | §3 表逐项有验收                                                                                           |
| U4  | 旧名不立刻消失：一个版本内保留隐藏别名 + 一行迁移提示                                                                                                                                                              | spec 断言提示出现、功能仍可用                                                                             |
| U5  | 运行中行为可预期，且与 Codex 的 `available_during_task` 方向一致：`Plan/Review/Compact/Init/Clear/New` 运行中**不执行**（排队或拒绝并说明），`Status/Diff/Model/Permissions/Skills/Hooks/Mcp/Usage/Tasks` 立即执行 | 表驱动测试；TUI 现有 `immediate` 集合（`app.ts:2026-2051`）含 `/clear`，与 Codex 相悖，待实测后改（P0-6） |
| U6  | 完成必须来自 verdict，不是模型散文（沿用 `AGENTS.md`）                                                                                                                                                             | 完成类入口验收含 verdict 事件                                                                             |

## 5. P0：修已核对的真实缺陷（每项独立提交，带"改前红、改后绿"的回归测试）

> 工作区纪律：当前主 checkout 有他人未提交改动（`src/cli/tui/app.ts`、`renderer.ts`、`viewport.ts`、`input/mouse-route.ts`、两个 tui spec、`scripts/tui-feel/assert-layout.py`）。按 `AGENTS.md`，在独立 worktree 做：`git worktree add ../moss-slash -b slash-p0`，只按路径暂存。

| 编号     | 缺陷（证据）                                                                                                                         | 改法                                                                                                                                                                             | 验收                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **P0-1** | `/init` 死命令：目录声明 REPL，REPL 回 "not available"（`repl.ts:115,420`，PTY 实测），TUI 无处理                                    | `registry.ts` 新增 `initCommand`（与 `/review` 同构，`submitPrompt`）：无 `AGENTS.md` → 让模型分析仓库并生成；已有 → 增量审阅。去掉目录行 `surfaces:['repl']` 与 REPL 的拒绝分支 | 新增 `test/cli-init-command.spec.mjs`：`findRegistryCommand('/init')` 非空且调用 `submitPrompt`（内容含 `AGENTS.md`）；PTY `/init` 输出不含 "not available" |
| **P0-2** | `/plan` 无参只打印 `/mode` 帮助（PTY 实测）                                                                                          | `/plan` 独立为 `planCommand`：无参→进入 plan 并回显退出方式；`/plan <描述>`→进入后 `submitPrompt(描述)`。`/mode` 不再含 `/plan` 别名                                             | 新增 `test/cli-plan-command.spec.mjs`：`getCliInteractionMode()==='plan'`；带描述触发 `submitPrompt`；PTY `/plan` 后 `/mode` 显示 plan                      |
| **P0-3** | 自定义命令只在 REPL（`loadCustomCommands` 仅 `repl.ts:166` 引用）；TUI skill 调用丢参数（`app.ts:2061-2067`）；REPL 无 skill `/名字` | 抽 `resolveUserCommand(head,args,{customCommands,skills})`（`commands/custom-commands.ts`），两界面共用；顺序：内置 → 自定义 → skill → unknown；skill 提示词带 `$ARGUMENTS`      | 新增 `test/cli-user-commands.spec.mjs`：自定义命令与 skill 的 prompt 均含参数；同名内置优先；TTY 手测 `.moss/commands/hi.md` 出现在 `/` 菜单                |
| **P0-4** | `/loop` 与 CC 语义相反                                                                                                               | 目录移除；dispatch 保留一版：打印 "`/loop` 已改为 `/goal`" 后转发 `/task run`                                                                                                    | spec 断言提示与转发；PTY `/loop` 含迁移文案                                                                                                                 |
| **P0-5** | `/goal` 被隐藏，菜单只有需记子命令的 `/task`（U3/R1 违背）                                                                           | `/goal` 取消 hidden 与 surface 限制；语法跟 CC：`/goal <条件>`、`/goal clear`（现有 `--accept "<cmd>"` 作为 moss 增强保留）；`/task` 隐藏                                        | `cli-interactive-commands.spec.mjs`：`SLASH_MENU_ROWS` 含 `/goal`、不含 `/task`；PTY `/goal`（无参）打印用法；`/goal clear` 终止当前目标并有事件落盘        |
| **P0-6** | TUI 将 `/clear` 放在"运行中立即执行"（`app.ts:2045`），Codex 在运行中**禁用** `/clear`                                               | **先实测再改**：stub provider 起长 run，运行中 `/clear`，观察转录/会话文件/`running`。有异常→改为排队；无异常→保留并记"已观测"                                                   | 记录实测输出到 PR 描述；若改，spec 断言运行中 `/clear` 被排队                                                                                               |
| **P0-7** | TUI `/resume` 是 Task OS（`app.ts:1937-1940`），与 CC/Codex（恢复会话）冲突；REPL 无 `/resume`                                       | `/resume [id                                                                                                                                                                     | 名称]`恢复会话，无参打开会话选择器（复用`cli-main.ts:476`的选择器）；隐藏的`/task resume` 保持恢复任务                                                      | spec：`/resume` 不再调用 `runTaskShellCommand`；PTY/TTY 手测选择器出现并能恢复指定会话 |
| **P0-8** | `/tasks` 在 moss 是 Task OS 列表（`app.ts:1849`），在 CC 是后台工作                                                                  | `/tasks`（别名 `/ps`）列后台进程与子代理（吸收 `/jobs /bg /subs` 现有输出，数据源 `agent.asyncTasks.list()`）；Task OS 列表改 `/task view tasks`                                 | `tui-command-surface.spec.mjs` 更新；spec：`/tasks` 输出含后台进程/子代理区块，不含 Task OS 列表；旧名 `/jobs` 打印迁移提示后仍可用                         |

## 6. P1：对齐改名与内置行为（用户可见行为向主流靠拢）

| 编号                            | 内容                                                                                                                                                                                                                                              | 验收                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1-1** 别名补齐               | `/cost` `/stats`→`/usage`；`/new` `/reset`→`/clear`；`/checkpoint`→`/rewind`；`/bashes`→`/tasks`；`/ps`→`/tasks`；`/exit` 已有。全部不进菜单                                                                                                      | spec：别名解析到同一实现；`/help --all` 列出别名                                                                                                                                          |
| **P1-2** steer 内置             | TUI 运行中的普通消息：先 `agent.steer?.(sessionKey, text)`；返回 null 或被拒（无单一活动 run、不可 steer 的回合）→ 回退入队。队列内容显示在输入区上方，`↑` 取回编辑。`/steer`、`/queue` 保留隐藏别名并提示。强制排队的键位待 §9-1 核对 Codex 后定 | 新增 `test/tui-steer-default.spec.mjs`：stub 活动 run 下提交消息 → 调用 `steer`；`steer` 返回 null → 入队；PTY 手测：长 run 中发一条约束，下一个工具边界生效（转录里出现 `queued:` 回显） |
| **P1-3** `/stop` 同义化         | `/stop` = 停止后台进程（Codex "stop all background terminals"、CC 停后台会话）：遍历现有后台进程注册表调用 `killProc`；**不**再作为"打断 run"。中断统一 `Esc`/`Ctrl+C`                                                                            | spec：起一个 `exec_background` 的 sleep 进程，`/stop` 后进程已退出（读 PID 存活检查）；运行中 `/stop` 不中断主 run                                                                        |
| **P1-4** 工件可自然语言查询     | 检查系统提示是否已说明 `.moss/{tasks,evidence,deployments,failures}.jsonl` 的含义与位置；没有则补一句                                                                                                                                             | 新增基准用例（`bench/tasks/`）：问"上次部署为什么失败"，agent 应读取 `failures.jsonl`/`evidence.jsonl` 给出带出处的回答；或至少 spec 断言提示含这些路径                                   |
| **P1-5** 命令实现归一（纯重构） | 目录与注册表合并为同一数据；`app.ts`/`repl.ts` 的 if 链逐个迁入注册表；重复实现（`/usage`、`/permissions`）以注册表为准；`availableDuringRun: 'immediate'                                                                                         | 'queue'                                                                                                                                                                                   | 'reject'` 必填，初值机械迁移（P0-6 改后再更新） | `tui-command-surface.spec.mjs`/`cli-command-surface.spec.mjs` 扩展：目录行两界面皆可 dispatch；`rg "text === '/"` 命中数单调下降；`npm run verify` 绿；§8 探针前后一致（别名除外）。不设行数目标 |

## 7. P2：提升完成率（有 A/B 门槛，不过门不默认开）

现有证据：`bench/results/ab-best-of-n-*.json`（Δ=0 / −27.3，`DEFAULT-OFF`）；`ab-model-routing-*.json`（flash 97 vs pro 81.8，成本约 2.9 倍）；samples=3，噪声带内差异不作结论。

| 编号     | 内容                                                                                                                                                                                                                 | 与主流关系                                                              | 验收                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P2-1** | `/goal <条件>` 无 `--accept` 时**提议**验收命令：探测 `package.json scripts.test`、`Makefile test`、`pyproject`/`go.mod` 等，最多 3 个候选，Enter 接受、可编辑、`n` 跳过（跳过则明确告知仅契约裁决）；探测不到不编造 | 对齐 CC `/goal <条件>` 的使用姿势，补上 moss 的可机检要求               | `test/cli-goal-propose.spec.mjs`（有 test 脚本的临时工作区 → 候选含 `npm test`；空工作区 → 无候选且文案诚实）；`task-os-{a-coding,b-device,c-failure-repair}` 不低于改前基线（改前先 `npm run bench -- --task <id> --samples 3` 留档） |
| **P2-2** | `/task verify [id]`（隐藏，不占顶层名）：用现有 `createTaskVerdictProvider`（`src/core/task/verdict.ts:136`）出一次裁决，不触发模型回合；FAIL 提示 `/goal` 续跑                                                      | CC 的 `/verify` 语义是"运行应用并观察"，故**不**占用 `/verify` 这个名字 | spec：失败验收命令 → exit 1 且 timeline 有 `acceptance_failed`；修复后再跑 → `accepted`；PASS 仅来自 verdict                                                                                                                           |
| **P2-3** | `/plan` 批准门（`exit_plan` 类只读工具，开关 `MOSS_PLAN_GATE`，**默认关**）                                                                                                                                          | CC plan 模式有批准语义                                                  | `npm run bench:ab`，`hard-ambiguous-spec`、`hard-coupling-refactor`，`--samples 5`，对照 `noise-band.json` swing；hardScore 不低于关闭态且超出噪声带才可默认开                                                                         |

## 8. 验收手册

### 8.1 PTY 探针

`/tmp/slashprobe/probe.py`（已验证可运行）：伪终端启动 `MOSS_NO_TUI=1 node dist/cli.js`，逐条发送，剥离 ANSI 后打印。落地时放入 `scripts/slash-probe.py`，缺 python 时跳过。**TUI 路径必须另做真 TTY 手测**（探针只覆盖 REPL）。

改前基线（2026-10-09 实测）→ 期望：

| 输入    | 改前                                                                                                         | 期望                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/init` | `[help] /init is not available in this REPL…`                                                                | 进入运行路径                                                                                                                                              |
| `/plan` | 打印 `Interaction mode: full` + 模式帮助                                                                     | 含 plan 模式确认；其后状态为 plan                                                                                                                         |
| `/loop` | `Usage: /loop <goal> — same as /task run…`                                                                   | 含"已改为 /goal"提示                                                                                                                                      |
| `/foo`  | `Unknown command` + `Available: /model /mode /compact /task /review /doctor /diff /permissions /clear /help` | `Available` 为：`/model /compact /goal /review /doctor /diff /permissions /clear /plan /help`（无 `/mode`、无 `/task`；具体集合由目录派生，以 spec 为准） |
| `/mode` | 模式帮助                                                                                                     | 提示迁移到 `Shift+Tab` / `/plan` / `/permissions`，功能仍可用一版                                                                                         |

### 8.2 自动化与收口

- 每项：`npm run test:filter -- --filter <spec>`，先确认改前红再绿。
- 阶段收口：`npm run verify`；P2 额外 `task-os-*` 基准对比；`examples/` 三个嵌入示例实跑。
- 公共面：若 `/task verify` 等能力需要 SDK 导出，按 `AGENTS.md` 更新 `sdk-contract` 快照并同提交。
- 每个 PR 的完成定义：`git status --short` 只含本项文件；新增 spec 改前红改后绿；`npm run verify` 绿；PTY 对照表对应行达标；报告写明跑了什么、没跑什么（如无真实 provider key）。

## 9. 仍未核对（落地前补；不阻塞 P0-1~5）

1. **Codex TUI 的"运行中发消息"键位**：steer 默认键与"强制排队"键（只确认了 `steer()`/`pending_steers`/`rejected_steers_queue` 的存在，未读键位绑定）。P1-2 定键位前必须读 `codex-rs/tui` 的 composer 键位并核对 CC 文档的队列行为。
2. **moss `/permissions` 面板是否已含"批准模式"选择**（Codex 的 `/permissions` 含义）。若无，需把模式选择并入该面板，`/mode` 才能下线。
3. **`/clear` 运行中的真实行为**（P0-6 实测）。
4. **TUI 真 TTY 下** `/`、`/init`、自定义命令、会话选择器的画面（本次 PTY 探针仅覆盖 REPL，TUI 结论来自源码阅读）。
5. **系统提示是否已说明 `.moss/*.jsonl` 工件位置**（P1-4 的前提）。
6. opencode 内置斜杠清单（API 超时，未用作依据）；Codex 完整 `/goal` 交互。

## 10. 不做

`/theme /vim /voice /pets /statusline /title /feedback /share /upgrade /ide /memory`（个性化/账号/云端，或属 `AGENTS.md` 冻结范围）。`/fork /btw /copy /add-dir` 暂缓：CC/Codex 有，但无完成率证据，需先按 §7 的格式提出失败模式再立项。
