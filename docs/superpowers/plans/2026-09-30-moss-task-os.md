# Moss Task OS — 统一 Task Runtime（2026-09-30 立项）

上游总指令：把 Moss 从 Agent Harness 升级为 **Agent Task Operating System**。
North Star: **One Intent → One Task → One Agent Loop → One Verified Result**。
TUI 重做（Robot Development Mission Control）由专门会话负责，本文档只覆盖
Runtime 侧；TUI 消费的类型/事件契约由本线定义（§1），TUI 会话照契约实现。

## 范围分工（2026-09-30 22:05 与 TUI 会话实时划界）

- **TUI 线领地**：`src/cli/tui/**`、`src/core/task-runtime/**`（Mission Control 投影层：
  artifacts.ts 读写 + runtime.ts 视图模型，从 `.moss/` 工件 + MossAgentEvent 流推导展示态）。
- **Runtime 线领地（本线，worktree `moss-taskos` / branch `task-os`）**：
  `src/contracts/task-runtime.ts`（协议：TaskPhase/TaskEvent/Failure/Repair/Snapshot）、
  `src/core/task/**`（引擎：store/verdict/engine/capability）、REPL `/task`、headless
  `moss task run`、SDK 导出、LoopScheduler 绑定、bench A/B/C。
- 命名约定：`contracts/task-runtime.ts` = 协议（写路径真相源）；`core/task-runtime/` =
  TUI 投影（读路径）。TUI 投影层后续应改为消费 `task-events.jsonl`（经
  `core/task/task-store.ts`），而不是从工件+事件流启发式推导状态——接缝已在
  TaskStateSnapshot/taskStatusView 预留（`taskStatusView(phase)` 输出即 MissionState）。
- 两线在 `contracts/index.ts`、`core/index.ts`、`tools/task-tools.ts` 等共享文件上
  只做加法编辑；合并时以先落 main 者为基，后者 rebase。

## 原始范围

- 本线：Task 模型 / 状态机 / 统一存储 / Runtime 引擎 / Goal Loop×Acceptance 合一 /
  Failure-Repair 一等公民 / Timeline-History-Resume / REPL-Headless-SDK 入口 /
  能力发现（Skills×MCP×Device）/ Task A-B-C 基准与指标。
- TUI 线：Mission Control 界面，消费 `TaskStateSnapshot` + `TaskEvent`。

## 冲突解决（对应总指令 §23）

1. 两套 Goal/Acceptance → 统一为 **VerdictProvider**：命令裁决（runAcceptanceCommand）
   与契约裁决（evaluateAcceptance）是同一接口的两个实现；Goal Loop 降级为 Task Runtime
   的一种执行策略（execution policy），不再是独立产品概念。
2. 两套交互面 → 四入口（TUI/REPL/Headless/SDK）共享同一个 `TaskRuntime` + 同一份
   `.moss/` 持久化，行为只有一份。

## 里程碑（每步独立可交付、verify 绿才 commit）

| #   | 交付                                                                                                                                                   | 硬验收                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| M1  | `src/contracts/task-runtime.ts`：TaskPhase 状态机 + TaskEvent + Failure/Repair/Plan 类型 + 纯转移函数                                                  | 新 spec：非法转移被拒、事件驱动转移全表覆盖；`npm run verify` 绿                                |
| M2  | `src/core/task/task-store.ts` + timeline：统一 append-only 存储（沿用 tasks/evidence/acceptance/deployments jsonl，新增 task-events/failures/repairs） | spec：写入→快照→latest-wins→timeline 回读正确                                                   |
| M3  | `src/core/task/task-runtime.ts` + `verdict.ts`：创建/恢复/执行/验证/修复循环，事件流订阅                                                               | spec：mock agent 跑通 execute→verify FAIL→repair→reverify PASS 全链状态转移                     |
| M4  | 工具层接线：task_define/record_evidence/task_acceptance 落 TaskEvent；新增 record_failure/record_repair/task_plan_update                               | spec：工具调用后 timeline 出现对应事件；completion gate 改读 runtime 状态（保留字符串匹配兜底） |
| M5  | 入口：REPL `/task`、headless `moss task run`、SDK 导出（semver minor + 快照重生成）                                                                    | spec + 冒烟：`moss task run` 真跑一个本地任务产出 accepted 状态                                 |
| M6  | Goal Loop 合一：LoopScheduler 可绑定 taskId，acceptance 结果双向落事件；/goal 与 MOSS_GOAL_VERIFY_LOOP 路径接入                                        | 既有 goal-loop/loop-scheduler spec 全绿 + 新绑定 spec                                           |
| M7  | 能力发现：goal→skills(when/description 匹配)+device tools+MCP 注入 planning 上下文                                                                     | spec：camera goal 命中 camera skill 行                                                          |
| M8  | 基准 A/B/C + 指标（acceptance rate / repair attempts / false success / time / tokens / tool calls）                                                    | bench harness 能按 task 聚合输出指标；A 本地实跑、B/C 设备实跑（无设备 env 则跳过不判负）       |
| M9  | DoD 证明：自然语言→Task→Plan→执行→设备→证据→验证→修复→验收 整链真实跑通（Task C 故障修复为必选证明）+ AGENTS.md 更新                                   | 夜报含每类任务的真实运行记录与指标                                                              |

## 指标口径（M8 起生效）

- Task Success Rate = acceptance PASS 的任务 / 总任务
- False Success = 无 backing evidence 的 PASS（runtime 层面结构性不可能 → 用基准实测证明）
- Repair Attempts = task-events 中 repair_applied 计数
- 人工介入率 = blocked_on_user 事件 / 总任务

## 纪律

- 每步完成后：build → verify → 真跑一次受影响路径 → commit（直推 main，git add 只点名自己的文件，push 前 pull --rebase 防并行 TUI 会话撞车）。
- 不动 `src/cli/tui/`（TUI 会话领地）；契约改动在本文件记录后立即 push 供 TUI 会话同步。
- goal-loop 效率方向：合并验收后用既有 bench:ab 复测，方向是更少 iteration 更高 success。
