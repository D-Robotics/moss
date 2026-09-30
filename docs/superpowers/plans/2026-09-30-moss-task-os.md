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

## 完成态（2026-09-30 23:29，merge 7a5777c5 入 main）

| #   | 结果 | 证据                                                                                                                                                                                                     |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | ✅   | `contracts/task-runtime.ts` + `test/task-runtime-contract.spec.mjs`（11 测试，含 plan_ready-from-draft 回归）                                                                                            |
| M2  | ✅   | `core/task/task-store.ts` + `test/task-store.spec.mjs`（latest-wins/timeline/非法转移拒绝）                                                                                                              |
| M3  | ✅   | `core/task/{task-engine,verdict}.ts` + `test/task-engine.spec.mjs`（mock 全链 repair、预算耗尽、命令裁决、resume）                                                                                       |
| M4  | ✅   | 工具层事件接线 + `test/task-tools-runtime.spec.mjs`；gate 读 runtime                                                                                                                                     |
| M5  | ✅   | `moss task` CLI（AgentReady 分发）+ REPL `/task` + SDK 263 符号快照；**真跑 PASS**：qwen3.8-max 全链含真实修复循环（attempts 2 / repairs 1 / failures 1，文件落盘，exit 0）                              |
| M6  | ✅   | LoopScheduler `onAcceptanceVerdict` 镜像 + /goal 绑任务 + MOSS_GOAL_VERIFY_LOOP 镜像；`test/task-goal-unification.spec.mjs`                                                                              |
| M7  | ✅   | `core/task/capability.ts` 词干匹配 + planning 注入；`test/task-capability.spec.mjs`                                                                                                                      |
| M8  | ✅   | bench `task-os-a-coding` 1/1 PASS（8 turns/18s）、`task-os-c-failure-repair` 1/1 PASS（hard 100/100，13 turns/28s，oracle 先败后修）；`task-os-b-device` requiresEnv 就绪；`scripts/task-os-metrics.mjs` |
| M9  | ✅   | merge 7a5777c5（TUI v0.21 + task-os 共存，168 spec 全绿）；AGENTS.md 双线导航；本审计                                                                                                                    |

### 过程中发现并修复的真断点（按 §28 执行纪律）

1. headless 审批把 `task_define` 拦死在第一步 → runtime_state 免审（危险类不变）。
2. 零 criteria 契约会自动 PASS → "无可检完成定义不得验收"守卫。
3. **agent 自建任务（task_define）不进状态机**——整个 robotics P0 主路径对 runtime 不可视 → task_define 即入机（task_created→plan_ready）。
4. 状态表 `plan_ready` from draft 值错位（M1 同型笔误第二处，spec 漏格）→ 修正 + 回归测试。
5. `moss task run` 首跑崩溃：方法脱绑丢 `this` → 方法调用形式。

### DoD 对照（§27）

- NL → Task → Plan → Agent Execution → Tools → Runtime → Evidence → Verification → Repair → Acceptance：**两种驱动方式各真跑通过一次**（engine 驱动 `moss task run` + agent 工具驱动 bench C），模型散文全程无法移动状态。
- Real Device 段：`task-os-b-device` 已就绪（requiresEnv）；本机无设备凭据，待有设备环境时 `node scripts/run-benchmark.mjs --task task-os-b-device` 即可出真样本（真机链路本身已有 main 上 device-deploy-verify 1/1 背书）。
- False Success：结构性不可能（无证据即拒收 + C 类判分明确拒绝 pass-before-fail）。

## 收口更新（2026-09-30 23:51）

- **DoD 全链含真机段闭合**：`task-os-b-device` 1/1 PASS on rdk-sandbox 真机（22 turns/172s/36 tools）——中途遭遇真实 sshd MaxStartups 连接风暴，agent 自行诊断恢复、取回真实遥测后验收 PASS。
- **三类任务 3/3 = 100%**：A（编码 8t/18s）、B（真机 22t/172s）、C（故障修复 hard 13t/28s），deepseek-flash 驱动；engine 驱动的 `moss task run` 另由 qwen3.8-max 三次真跑背书（含合并构建）。

## M11 审批=任务体验（已交付，063a8e17）

审批提示带 Task context 块：operation / task+phase+attempt / target device / reason / impact（restart→服务中断、deploy→覆盖路径、默认→设备状态变化）/ if-declined（任务阻塞待人）。device_exec/device_file_write/device_deploy 新增 `reason` 输入直达审批块。

## M12 goal-loop 迭代效率研究（§24，基于 6 次已录运行的逐轮分类）

方法：对 bench/results 全部 task-os 运行的 stream-json 逐轮分类（PLAN/RUN/CODE/READ/VERIFY/EVIDENCE/REPAIR-REC/TODO/DEVICE/OTHER）。

结论（按浪费轮数排序）：

1. **环境故障吃掉 60% 轮数（B 运行 22 轮中约 15 轮）**：sshd MaxStartups 连接风暴 → agent 逐工具试错、考古式排查。修复方向：device 连接握手失败自动指数退避重试（2s/5s/10s），错误信息直接给"server overloaded, retrying"而非裸 SSH 错误。
2. **截断逼出重读轮（A 运行每 run 2-3 轮）**："read tool is returning a stub / earlier read result was elided"——工具输出截断吃掉文件内容后只能重读。修复方向：spec/源码类 read 保留紧凑摘要或小文件截断豁免。
3. **双清单冗余（每 run 2-3 轮）**：task_plan_update 与 todo_write 并行维护两份清单。修复方向：任务运行中抑制 todo_write。
4. **重复 record_failure（C 运行 3 连发）**：修复方向：同 task+attempt 幂等（返回已有 failureId）。
5. 刚性最小集 ≈ 5-7 轮（PLAN 1 + CODE 1 + RUN 1-2 + EVIDENCE 2 + VERIFY 1-2）；当前 8-22 轮的差值几乎全部来自 1-4 项。

方向不变：更少 iteration + 更高 task success；已识别浪费点均有机械修复路径，无需提高 loop iteration 上限。

## 增强层收口（2026-10-01 00:07，74426eb3 入 main）

- **M12 修复落地并实证**：设备连接退避后 Task B 真机复测 9 turns/24s/13 tools（前 22/172s/36）——同 PASS，轮数 −59%、耗时 −86%；record_failure 幂等。
- **§14 起步**：create/fan-out/background sub-agent 提示前置 live task 简报（goal/plan/acceptance/open failures/task_id），共享任务上下文取代孤立提示。
- 全量 171 spec 绿；main = 74426eb3。
- 下一迭代候选（按 §28 找最大断点）：read 截断摘要（消除重读轮）、任务中抑制 todo_write、MCP 按任务动态选择、skills 的 procedure/verification 元数据建模。
