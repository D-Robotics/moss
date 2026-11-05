# 验收 / 闭环 / 长程任务 / 目标任务：产品对照与 Moss 切片设计

日期：2026-11-06 · 目的：把 Cursor / Claude Code 在"怎么算做完、怎么持续跑、跑很久怎么办、目标怎么定"
这四件事上的机制拆到可实现的细节，再据此排出 Moss 的下一切片。
本轮落地切片见 §5.1（checkpoint 跨会话持久化，backlog B92）。

## 1. 产品侧机制拆解

### 1.1 验收（acceptance）：不是模式，是叠加在 loop 上的四层

Cursor 的验收没有单独开关，是四层叠加（详见
[`2026-11-05-cursor-acceptance-loop.md`](../research/2026-11-05-cursor-acceptance-loop.md)）：

| 层  | 产品事实                                                                                                                                                      | 机制含义                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| L1  | agent 在 loop 内持续自检、跑测试、修错误（[learn/agents](https://cursor.com/learn/agents.md)）                                                                | 提示词 + terminal 工具约定，不是独立功能                          |
| L2  | Agent Review / Bugbot：独立评审上下文，findings 带严重级与 patch 建议；autofix 最多 **3 次/PR**（[bugbot](https://cursor.com/docs/bugbot)）                   | 评审者与写码者上下文隔离；findings 结构化回灌修复；有上限防死循环 |
| L3  | hooks 的 `stop` 事件：在 agent 声称完成时插入检查，`loop_limit` 默认 **5**、可 `null` 无限，`failClosed` 默认 false（[hooks](https://cursor.com/docs/hooks)） | 完成门是用户可插拔的脚本契约，不在产品代码里写死                  |
| L4  | 外部信号验收：CI / PR checks / Bugbot findings 变化都算"验收结果"（[agent/overview](https://cursor.com/docs/agent/overview)）                                 | 验收位置不只在 diff 后，还在每个外部信号回来时                    |

Claude Code 侧的对应事实：`Stop` hook 可在 Claude 收尾时阻断并要求继续；`TaskCompleted` /
`TeammateIdle` 是 agent teams 的文档级质量门（见
[`claude-code.md`](../research/2026-11-04-next-capabilities/claude-code.md) 第 12.2 节）。

**提炼出的验收原则**（Moss 已部分满足，见 §3）：

1. 验收必须机器可判（命令退出码 / 测试 / CI），模型散文永不算通过。
2. 评审者上下文必须干净（独立子代理），findings 要能结构化回灌修复循环。
3. 修复循环有硬上限（Cursor Bugbot 3 次；Moss 现为 3 次 review-repair、5 次 task repair）。
4. 验收失败要能低成本退回去（checkpoint / git），否则修复越修越乱。
5. 完成门只在"声称完成"那一刻拦截，最多一次，且允许"我未验证，原因是…"的诚实通道。

### 1.2 闭环（closed loop）：外部信号必须能叫醒 agent

- Cursor：`/autopilot` 把 PR 交给云子代理，持续处理反馈、冲突、失败的 checks；
  Projects 的 **Subscriptions** 监听 Slack / PR / CI / schedule，"听到信号就行动，不等你开口"；
  `/loop` 按间隔唤醒，间隔可由 agent 自己选。前提是 **environment definition**
  （`.cursor/environment.json`）——官方原话大意："跑不了测试的 agent 关不上环"。
  （[cursor.md](../research/2026-11-04-next-capabilities/cursor.md) 5.14、6.13、6.4）
- Claude Code：13+ 个 hook 事件把外部/内部信号接回 loop（`Stop`、`SubagentStop`、
  `PreCompact`、`TaskCompleted`…）；后台任务与 task list 让"等待"不占住主会话。

**闭环原则**：① 每轮用全新会话（避免上一轮的自我辩护污染判断）；② 状态外置（PR/branch/task
board/文件），不靠对话记忆；③ 失败输出必须喂回下一轮；④ 唤醒源可以是时间、CI、PR review、
文件变化——Moss 现在只有"时间"（`--every`）和"人手动重跑"。

### 1.3 长程任务（long-running）：状态持久 + 上下文有界 + 可回滚

Claude Code 的 checkpoint 语义最完整（今天直接核对官方页
<https://code.claude.com/docs/en/checkpointing>，与仓库 2026-11-04 抓取一致）：

- 每个"开启一轮对话的 prompt"之前自动快照；只覆盖**文件编辑工具**的改动；
- 每会话保留**最近 100 个** checkpoint，**和对话存在一起，所以 resume 之后 `/rewind` 仍然可用**；
- 动作：恢复代码 + 对话 / 只恢复对话 / 只恢复代码 / 从这里开始总结 / 到此为止总结；
- 不覆盖：bash 命令、子代理编辑、外部改动；官方明说"不是版本控制替代品"；
- 失败模式：快照被 `cleanupPeriodDays` 清扫后 rewind 报 `No files were restored`。

Cursor 的 checkpoint 是"只用来撤销 agent 改动"（不恢复对话，官方建议用 Git 做永久版本控制），
并明确云代理有自己的 VM + branch。两边合起来的原则：

1. 长跑必须有"每轮一个恢复点"，且恢复点**跨进程/跨 resume 存活**；
2. 上下文必须有界：compaction 后仍要知道"目标是什么、做到哪一步"（Moss 用
   `<active-task>` / `<active-todos>` 锚点解决）；
3. 回滚粒度 = 一轮，不是单个工具调用；
4. 长跑要能审计：每轮用了什么命令、退出码、改了哪些文件（Cursor 是 PR 记录，Claude 是
   transcript + task dir）。

### 1.4 目标任务（goal）：先编译成可机检的验收，再谈自主

- Cursor `/goal <objective>`：长活目标"直到完全完成"，CLI 里 `Ctrl+C` 暂停；`/loop` 负责
  有节奏地重新唤醒；`/multitask` 并行异步子代理。产品文档强调 "agent reads each message as
  a new job"——所以目标必须外置成可恢复的状态。
  （[agent/overview](https://cursor.com/docs/agent/overview)、cursor.md 5.14）
- Claude Code 没有 `/goal`，等价物是：plan mode 先定方案 + task list / agent teams 的共享
  任务板（teammate claim/complete，依赖自动解锁）+ hooks 在 `TaskCompleted` 时做质量门。
  任务目录 `~/.claude/tasks/<team>/` 在会话结束后仍保留（受 `cleanupPeriodDays` 管）。

**目标原则**：① goal 在开跑前就被编译成"可机检的 acceptance"（命令/指标），不是自然语言
承诺；② 裁决只能来自 verdict provider；③ 目标状态必须外置、可暂停、可 resume；④ "完成"
不是模型说完成，是 verdict PASS + evidence 存在。

## 2. Moss 现状（代码事实，2026-11-06）

| 机制               | 现状                                                                                                                                                                                      | 位置                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 任务契约/证据/裁决 | Goal + 可机检 acceptance criteria → `record_evidence` → `task_acceptance`；统一状态机与 `.moss/` 工件；修复循环默认 5 次；命令裁决优先于契约裁决                                          | `src/core/task/task-engine.ts`、`acceptance-command.ts`、`verdict.ts`                |
| `/goal`            | 交互入口把 goal 编译成 `/task`，先提议验收命令（从 package.json test / Makefile test / pytest / unittest / go.mod 探测，最多 3 个候选，找不到就诚实说明不编造）                           | `src/cli/repl.ts:817`、`src/cli/tui/app.ts:2020`、`src/cli/commands/goal-propose.ts` |
| 完成门             | ① 任务验收门：定义 task 但无裁决 → 拦一次；② 验证门：改了文件却没有任何检查 → 拦一次；③ 自动评审：`reviewMode=auto` 时有变更就评审，findings FAIL 可驱动 3 次修复循环；诚实"未验证"可放行 | `src/core/loop/acceptance-completion-gate.ts`、`verification-completion-gate.ts`     |
| 闭环               | `moss loop --until <cmd>`：每轮全新 headless 会话 + 命令裁决，失败输出喂回下一轮，`--max`（≤20）、`--every` 节流；exit 0 只来自检查命令                                                   | `src/cli/loop-command.ts`                                                            |
| 声明式编排         | `moss workflow run/resume/status/list`：JSON 计划按依赖分波，每步全新会话，失败只阻塞依赖者，状态在 `.moss/workflows/<runId>/state.json`                                                  | `src/cli/workflow-command.ts`                                                        |
| 长程状态           | compaction 摘要里保留 `<active-task>`（契约 + 最新裁决）与 `<active-todos>`；session 可 `--continue` / `moss resume`                                                                      | `src/context/compaction.ts`、`src/cli/runtime.ts`                                    |
| checkpoint         | 每轮 `open()`，写文件前备份、写后记 hash；`/rewind [seq]` / `/undo` 恢复文件；**本轮起元数据持久化、跨 resume 可见、保留 100 个并清理孤儿备份**                                           | `src/cli/file-checkpoint.ts`、`src/cli/repl.ts:434`、`src/cli/tui/app.ts:2423`       |
| 预算               | `budget {maxTokens,maxToolCalls,maxTurns,maxWallMs}` 配置 + `--max-turns`                                                                                                                 | `src/core/agent/moss-agent-types.ts:176`                                             |

## 3. 差距清单（只列真实缺的）

| ID  | 机制     | 差距（对照产品）                                                                                                                                                                                                                                                                                                                            | 证据                                                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| S1  | 长程     | ~~`/rewind` 只恢复文件，**不恢复对话**~~ → **已修（B93，2026-11-06）**：`/rewind`/`/undo` 恢复文件后调 `agent.rewindConversation` 并报告丢弃的消息数；真实 deepseek 验证「撤销 ORANGE 那轮 → 再问 secret 答 BANANA，跨进程重开同 session 仍答 BANANA」                                                                                      | `src/cli/repl.ts`、`src/cli/runtime.ts`、`src/core/agent/moss-agent.ts`                                                      |
| S2  | 长程     | ~~`open()` 的 `messageCount` 在交互运行时传的是默认 0~~ → **已修（B93）**：新增 `MossAgent.countSessionMessages`，REPL/TUI 回合开始前 `await` 真实历史长度再 `open(label, count)`；探针断言 checkpoint 跨重启带回正确回滚点                                                                                                                 | `src/core/agent/moss-agent.ts`、`src/cli/repl.ts`、`src/cli/runtime.ts:2005`                                                 |
| S3  | 闭环     | ~~`moss loop` 没有持久化尝试账本~~ → **已修（B94，2026-11-06）**：每轮写 `.moss/loops/<runId>.jsonl`（退出码/耗时/检查输出尾部/sessionKey/agentError）+ 结束 summary（passed/attempts_exhausted/budget_exhausted）；失败摘要列出 git status 改动                                                                                            | `src/cli/loop-command.ts`                                                                                                    |
| S4  | 闭环     | ~~没有整轮墙钟熔断~~ → **已修（B94）**：`--max-duration` 在两次尝试之间检查，超时停止并记 `budget_exhausted`（不切断进行中的回合）；真实 1ms 预算跑只执行 1 轮                                                                                                                                                                              | `src/cli/loop-command.ts`                                                                                                    |
| S5  | 闭环     | 唤醒源只有时间（`--every`）和人工重跑；没有 CI/PR/文件变化触发（Cursor Projects Subscriptions 的等价物）                                                                                                                                                                                                                                    | 无 watcher 代码                                                                                                              |
| S6  | 验收     | 自动评审的 findings 依赖模型自述（`review_changes` 结果轮），没有把 findings 落成**结构化记录**（severity/id/patch）供跨轮复检与统计                                                                                                                                                                                                        | `verification-completion-gate.ts` 的 review-fail 分支                                                                        |
| S7  | 验收     | ~~完成门的诚实通道只有"终稿写 unverified"；没有"验收命令不可用/超时"的机器可判降级~~ → **已修（B97，2026-11-06）**：`failureKind`（exit_nonzero/timeout/command_unavailable，126/127/ENOENT/超时）+ `TaskVerdict.blocked`；引擎与 `task_acceptance` 立即 `blocked_on_user{reason}`，不耗修复预算；普通非零仍修复；`task list` 显示原因      | `src/core/task/acceptance-command.ts`、`src/core/task/verdict.ts`、`src/core/task/task-engine.ts`、`src/tools/task-tools.ts` |
| S8  | 目标任务 | ~~goal 暂停/恢复在交互里是 Ctrl+C 中断，**没有显式 pause 状态**~~ → **已修（B95，2026-11-06）**：raw mode 下 `0x03` 与 SIGINT 都接线到 AbortController；Ctrl+C/Esc 暂停（`task_failed{detail:"aborted"}`），打印 paused 文案 + task id + `/goal resume`/`/task resume`/`/goal clear`；`/goal resume` 接续同一 task（timeline 有 `Resumed`） | `src/cli/repl.ts`、`src/cli/tui/app.ts`、`src/cli/goal-pause.ts`                                                             |
| S9  | 目标任务 | ~~没有目标级 rollup~~ → **已修（B96，2026-11-06）**：`runTaskCommand` 在 run/resume（REPL `/task`、`/goal`、TUI、headless 共用）结束时写 `.moss/goals.jsonl`（outcome/attempts/repairs/turns/耗时/裁决命令/sessionKey，aborted 也写）；`moss task list [--limit N] [--json]` 给跨会话汇总，最新在前                                         | `src/core/task-runtime/goal-runs.ts`、`src/cli/task-run.ts`、`src/cli/task-list.ts`                                          |
| S10 | 长程     | `--add-dir` 的附加目录不会被 checkpoint 跟踪？——会（path 解析后同样 track），但子代理/后台会话的编辑不在 checkpoint 里（与 Claude 一致，属于文档化边界，不修）                                                                                                                                                                              | `file-checkpoint.ts` trackBeforeWrite 仅宿主工具                                                                             |

## 4. 本节结论

Moss 在"验收 + 目标任务"上的机制深度已经接近甚至超过产品文档可见部分（状态机、命令裁决、
证据链、自动评审 + 3 次修复、完成门诚实通道）。真正落后的是**长程任务的可恢复性**与
**闭环的审计/熔断**：

- 长程：恢复点跨 resume 存活（S1 已落地一半，文件恢复已持久化；对话恢复是下一片）；
- 闭环：尝试账本（S3）与整轮预算/熔断（S4）；
- 目标：显式 pause 状态（S8）与跨运行 rollup（S9）。

## 5. 切片排序与验收方式

| 优先级 | 切片                                                                                                                                                                                          | 验收（必须真实运行）                                                                                                                      | 状态                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| P0     | 5.1 checkpoint 元数据持久化 + 100 保留 + 孤儿备份清理（长程恢复点跨 resume 存活）                                                                                                             | 探针 3/3（新实例列出/恢复/100 上限/坏文件降级）+ 真实 deepseek-flash：写文件→退出→`--session` 重开→`/rewind` 列出→`/rewind 1` 恢复 BEFORE | 本轮完成（B92）               |
| P0     | 5.2 已完成（B93） `/rewind` 同时回滚对话（接 `agent.rewindConversation`），`open()` 传真实 messageCount                                                                                       | 真实两轮对话后 `/rewind 2`：文件恢复 + 下一问模型答 BANANA 而非 ORANGE（退出后新进程同 session 复验仍答 BANANA）                          | 已完成                        |
| P1     | 5.3 已完成（B94） `moss loop` 尝试账本 `.moss/loops/<runId>.jsonl` + 结束时 summary                                                                                                           | 探针 3/3 + 真实三跑（通过/次数耗尽/预算耗尽）；ledger 字段与 reason 全部核对                                                              | 已完成                        |
| P1     | 5.4 已完成（B94） `moss loop --max-duration` 整轮熔断 + 诚实 stop reason                                                                                                                      | 真实 `--max-duration 1ms --max 3` 只跑 1 轮，summary `budget_exhausted`；不承诺下一轮                                                     | 已完成                        |
| P2     | 5.5 已完成（B95） goal 显式 pause：REPL Ctrl+C（raw 0x03）/ TUI Esc 暂停 + 任务 id + `/goal resume` 继续                                                                                      | 探针 4/4 + PTY 实测 Ctrl+C 暂停后 `/goal resume` 接续同一 task 到 PASS（timeline `Task aborted → Resumed → Acceptance passed`）           | 已完成                        |
| P2     | 5.6 findings 结构化（`.moss/review.jsonl` 已有？扩 severity/id/patch 字段）+ 跨轮复检                                                                                                         | `moss review check` + auto review 真实一轮                                                                                                | 待做                          |
| P2     | 5.8 已完成（B96） 目标级 rollup `.moss/goals.jsonl` + `moss task list [--limit] [--json]`（run/resume/abort 全记）                                                                            | 探针 6/6 + 真实三跑（pass/fail/resume 全部入账，同一 taskId 的历史相邻可查；JSON/limit/REPL 三种读法实跑）                                | 已完成                        |
| P3     | 5.7 外部信号唤醒（文件变化/CI 轮询）                                                                                                                                                          | 最小 watcher + 真实 CI 状态文件模拟                                                                                                       | 暂缓（需 orchestration 边界） |
| P2     | 5.9 已完成（B97） 验收命令不可用/超时 → `blocked_on_user`（区分基础设施失败与工作失败，不耗修复预算）                                                                                         | 探针 6/6 + 真实对照：修复前 113s/att:3 rep:2，修复后 38.9s/att:0 rep:0，退出码 1，blocked 原因进 timeline 与 `task list`                  | 已完成                        |
| P2     | 5.10 已完成（B98） 修正 oracle：`moss task resume <id> --accept "<cmd>"`（append-only note + timeline 专用标签；blocked 文案给出可复制命令）                                                  | 探针 9/9 + 真实链：blocked 36s exit 1 → resume --accept 12s exit 0，timeline `Acceptance command updated`，`task list` pass 行            | 已完成                        |
| P2     | 5.11 已完成（B99） 交互面闭环：`/goal resume [id] --accept "<cmd>"`（REPL/TUI 与 B98 对齐，自动补最新可恢复 id）                                                                              | 探针 5/5 + 真实 PTY REPL：blocked 60s → `/goal resume --accept` → PASS，timeline `Acceptance command updated`                             | 已完成                        |
| P2     | 5.12 已完成（B100） loop 账本读路径：`moss loop list` / `moss loop show`（最新在前、interrupted、每轮明细、`--json` 透传）                                                                    | 探针 6/6 + 真实 loop：pass 11s / fail 2s，list 两行、show exit 0/1 正确、JSON 合法                                                        | 已完成                        |
| P2     | 5.13 已完成（B101） loop 外部信号唤醒：`--watch <path>` + `--watch-timeout`（失败后等文件/目录签名变化再重试，超时以 `watch_timeout` 收工不烧轮次；等待时长进账本与 `loop show`）             | 探针 8/8 + 真实：外部进程 22s 落地文件→20.0s 唤醒后 attempt 2 PASS（27s）；watch timeout 4s→11s exit 1 且只跑 1 轮                        | 已完成                        |
| P2     | 5.14 已完成（B102） 完成门读结构化审查记录：`.moss/review.jsonl` 最新 verdict/findings（record id + critical/important 计数）驱动拦截；旧记录不拦、PASS 推翻旧 FAIL、子代理审查保留散文后备   | 探针 7/7 + 真实 run：reviewer FAIL(critical vuln.ts) → 注入修正 → 模型诚实报未解决 → exit 9                                               | 已完成                        |
| P2     | 5.15 已完成（B103） loop 历史区分运行中/被杀：start 记录写入 pid，同机判活得 `running`（in progress pid N）vs `interrupted`；`show` 打 PID、`--json` 带 status/pid、`att:N/M` 回退 start 记录 | 探针 6/6 + 真实长跑：运行中 list/show 显示 running(pid 83111)，kill -9 后 interrupted exit 1                                              | 已完成                        |

## 6. 参考

- Cursor：<https://cursor.com/learn/agents.md>、<https://cursor.com/docs/agent/overview>、
  <https://cursor.com/docs/bugbot>、<https://cursor.com/docs/hooks>、<https://cursor.com/docs/subagents>、
  <https://cursor.com/docs/agent/agent-review>
- Claude Code：<https://code.claude.com/docs/en/checkpointing>（今天直接核对）、
  <https://code.claude.com/docs/en/agent-teams>、<https://code.claude.com/docs/en/hooks>、
  <https://code.claude.com/docs/en/skills>
- 仓库既有调研：[`2026-11-05-cursor-acceptance-loop.md`](../research/2026-11-05-cursor-acceptance-loop.md)、
  [`2026-11-04-next-capabilities/claude-code.md`](../research/2026-11-04-next-capabilities/claude-code.md)、
  [`2026-11-04-next-capabilities/cursor.md`](../research/2026-11-04-next-capabilities/cursor.md)
