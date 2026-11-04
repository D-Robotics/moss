# Moss 验收闭环（Acceptance Loop）设计

状态：设计中，L1 已落地（2026-11-05）· 依据：[Cursor 验收/闭环调研](../research/2026-11-05-cursor-acceptance-loop.md)
受影响范围：`src/core/loop/`（完成门）、`src/core/task/`（任务裁决，已存在）、`src/core/subagent/`（评审者）、
`src/cli/commands/`（`/review`、`/accept` 入口）、hooks `Stop` 事件（已存在）。

## 1. 问题

Moss 的"完成"判定目前只覆盖一条路径：`task_define` → evidence → `task_acceptance`。这条路径很强
（状态机、证据、修复循环、诚实 FAIL），但它**只在用户/模型主动建契约时生效**。普通编码请求
（"实现 X"、"修这个 bug"）可以以一次 `write_file` + 一段成功叙述结束，没有任何机器检查，
也没有独立评审。Cursor 的做法不是另开一个验收模式，而是把检查叠加进普通 loop：

1. loop 内自检（跑测试、复读结果）；
2. 任务/提交后自动跑独立 review（Agent Review，quick/deep）；
3. 发现问题 → 修复 → 复检，上限 3（Bugbot autofix）；
4. 外部信号继续驱动（`/goal`、`/loop`、`/autopilot`）。

本 spec 把这条路径拆成 Moss 可实现的四层，并给出每层的验收方式。

## 2. 四层模型

### L1 完成前自检（已落地）

**契约**：任何修改了文件的 run，在最终答复前必须"看过真实结果"——复读文件、只读探测、或跑
test/lint/build/verify 类命令——否则终稿被拦截**一次**并注入纠正；明确说"未验证及原因"的诚
实答复放行。

**实现**：`src/core/loop/verification-completion-gate.ts`，接在任务验收门之后、宿主 `completionGate` 之前。
判定基于本 run 的消息历史（tool_use / tool_result），不依赖模型自述。

**边界**：

- 每次 run 最多拦截一次（`retryLimit: 1`），不劫持、不死循环；
- 没有文件变更的 run 不受影响（纯问答零成本）；
- 检查动作可在最后一次变更之后任意位置出现。

**验收**：见研究文档 §4；另加确定性探针（见 §5 P0-a）。

### L2 独立评审 pass（`review_changes` + `/review` 已落地，自动触发待做）

**契约**：L1 通过后，如果 run 有文件变更，跑一次**独立评审**（reviewer 子代理，干净上下文，
只拿 diff + 验收标准 + 项目规则），输出结构化 findings。触发方式：

- 默认：每次有变更的 run 结束后自动（对应 Agent Review "after every agent task"）；
- 手动：`/review`（已有命令升级为同一管线）；
- 上限：每 run 一次，depth = quick（默认）/ deep（显式要求或 diff 超阈值）。

**输入**：`git diff`（工作区）+ 可用时 `task_define` 的 acceptance criteria + 规则文件
（AGENTS.md / .moss/rules）+ 本次 run 的验证输出。
**输出**（结构化，写 `.moss/review.jsonl`）：
`{ findings: [{severity: critical|important|suggestion, file, line, summary, fix_hint}], verdict: pass|fail }`。
**不直接改代码**：reviewer 只读；修复由主 agent 或 L3 修复循环完成（职责分离）。
**验收**：植入一个已知缺陷的 diff → reviewer 必须报 critical/important 并给出位置；干净 diff → 报 pass 且不编造。

**2026-11-05 落地**：内置 `reviewer` 专家（`src/core/subagent/expert-registry.ts`，read-only、maxTurns 12）：
要求先读 diff 再读改动周围的真实文件、把每条未满足的验收标准映射成 finding、输出
`[Critical|Important|Suggestion] file:line`、干净就 PASS 且不得编造；只读意味着它只能提出修复、不能改代码。
真实模型验证（临时 git 仓库，植入 `add()` 由 `+` 改成 `-`）：

- 带验收标准 `add() must return the sum` → reviewer 报 **Critical + FAIL**，定位 `calc.js:2`，映射标准违例；
- 空 diff → reviewer 报 **PASS**，明确拒绝为凑数编造问题；
- 两次运行后工作区 `git status` 均未变（只读约束成立）。
  **2026-11-05 落地（P1-a）**：`review_changes` 工具（`src/tools/review-tools.ts`）把 L2 做成一条确定性管线：

1. diff 由 harness 用 `git diff HEAD`（或 `gh pr diff`）**确定性**收集，不靠模型回忆改了什么；超 400KB 截断并注明；
2. `reviewer` 专家以子代理跑在干净上下文里（quick=read-only，deep=verify 可跑只读检查），永远不能写；
3. reviewer 的合同输出（`VERDICT: PASS|FAIL` + `[Severity] file:line — … — fix: …` + `CHECKS:`）被解析成结构化 findings；
4. 记录追加到 `.moss/review.jsonl`（内置进 `.moss/.gitignore`），`listReviewRecords` 供修复循环/review 列表读取；
5. verdict 由 findings 计算：任何 critical/important 覆盖 reviewer 自述的 PASS；没有 VERDICT 行则 `unknown`（**不许**把散文当 PASS）。

`/review`（含 `/review <PR#>`）不再把 diff 贴进主会话让主模型自审，改为调同一工具再原样转述结果。
确定性回归门：verify stage `review-pipeline`（`scripts/verify/review-pipeline.mjs`，14 条断言，0.8s）。

真实模型验证（临时 git 仓库，deepseek-flash）：

- 植入缺陷（`add()` 由 `+` 改 `-`）+ 验收标准 → `verdict: FAIL`，`[critical] calc.js:2`，映射标准违例，
  `.moss/review.jsonl` 落 1 条结构化记录；
- 正确改动（`return 0` → `a + b`）→ `verdict: PASS`，0 findings，不编造；
- 干净工作区 → 57ms 返回 "Nothing to review"，**不**启动子代理、不写记录；
- 三次运行后工作区 `git status` 均只含测试前就存在的改动（reviewer 只读成立）。

仍缺：有变更 run 结束后自动触发（`review.mode` 配置）、L3 有界修复循环消费 review findings。

### L3 发现 → 修复 → 复检（有界；"review FAIL 不可静默丢弃"已落地）

**契约**：review verdict=fail 时，findings 作为**下一轮修复输入**（而不是丢给用户），修复后重跑
L1 的验证与 L2 的评审；上限 3 轮（Bugbot 口径）。每轮记录到 `.moss/task-repairs.jsonl` 或 review 日志，
最终给出"哪些还没解决"的诚实清单。

**与已有任务修复循环的关系**：任务 run 已有 `maxRepairAttempts`（默认 5）与 task 状态机；
L3 是**非任务 run 的等价物**，复用同一套"上限 + 证据 + 诚实 FAIL"纪律，不新建状态机。

**验收**：构造一个需要两轮修复才通过的缺陷（第一轮修得不对）→ 第二轮 findings 消失、
最终 exit 状态与日志一致；第三轮仍失败 → 输出未解决清单，不声称通过。

**2026-11-05 落地（L3 守卫）**：完成门新增一条规则——本 run 内独立 review 返回 FAIL
（`VERDICT: FAIL` / `"verdict":"fail"` / `Critical finding`）且终稿既不承认 findings、也没有后续 PASS
时，拦截一次，要求"修复并复评，或诚实列出未解决项"。这与 Bugbot 的 CI 语义一致：**未解决发现 =
失败状态，不是脚注**。真实验证：植入 `add()` 减法缺陷 + 明确要求模型"不要修复、以 All good 结束"，
模型在 review FAIL 后拒绝宣称完成，报出 criterion 未满足与 `calc.js:2` 位置；确定性探针新增 3 条断言
（FAIL 未承认→拦截 / 承认→放行 / 后续 PASS→清除）。**2026-11-05 落地（L3 有界修复）**：完成门把"review FAIL 不可静默丢弃"升级为**有界修复环**——
独立 review 判 FAIL 且终稿未认账时，最多驱动 **3 轮**"修复 + 复评"（与 Bugbot autofix 上限一致），
每轮纠正都会点明 findings；3 轮后仍未解决则交给 loop 的完成上限，把"带着 critical finding 宣称完成"
变成失败的 completion，而不是静默通过。承认 findings（修复说明或未解决清单）随时放行。
验证：确定性探针 14 条断言（含 3 轮边界）；真实模型运行：植入缺陷 + 指令"不要修复、以 All good 结束"，
模型 review FAIL 后**拒绝**宣称完成并给出未满足标准与 `calc.js:2`、建议修复，工作区未被改动。
**2026-11-05 落地（`review.mode=auto` + 新建文件进 diff）**：`review.mode`（`off|manual|auto`，
配置 `review.mode` 或 `MOSS_REVIEW_MODE`，默认 manual）让"改过文件但没评审"的 run 被拦一次，要求
`review_changes`；同一规则只提醒一次（用户明确要求跳过时模型需在终稿说明）。
同时修掉一个真实缺陷：**untracked 新文件此前不进 `git diff HEAD`**，评审对"只新建了一个文件"的
改动会答"Nothing to review"；现在未跟踪文本文件以合成 add-diff 注入（二进制只记文件名，预算内截断），
无 HEAD 的空仓库回退到 `git diff`。
真实运行（`review.mode=auto` + 只新建 `notes.txt`）：模型被拦一次 → 调用 `review_changes`（含未跟踪
文件，diffLines 19）→ PASS 记录 → `moss review check` 退出 0；反向对照：指令"不要评审"时模型**拒绝**
自己决定跳过并在终稿说明冲突，循环结束不再纠缠。确定性探针：`verification-gate` 19 条（含 auto 一次
提醒/已评审通过/手动不强制/评审算检查）、`review-pipeline` 19 条（含 untracked/二进制/无 HEAD）。

**2026-11-05 落地（评审机器状态面）**：`moss review list` / `moss review check`
（`src/cli/review-commands.ts`）把 `.moss/review.jsonl` 变成可门禁的状态：`check` 不启动模型，
读最新记录并映射退出码 **0 通过 / 1 有未解决问题 / 2 无评审或 verdict 未知**（未评审 ≠ 通过），
可直接放进 CI 或循环脚本。真实演示：植入缺陷 → 模型 `review_changes` 落 FAIL 记录 →
`moss review check` 退出 1 并打印 critical finding 与 fix；修复后复评落 PASS 记录 →
同一命令退出 0。`moss review list` 展示历史。确定性探针新增 3 条断言（17 总计）。
仍缺：有变更 run 结束后自动触发评审（`review.mode` 配置）、修复循环直接消费 findings。

### L4 外部信号闭环（后续，orchestration）

**契约**：把"继续闭环"的燃料从模型意愿换成外部信号：

- `moss loop --until <command>`：命令未通过就继续（CI 本地等价物）；
- `/goal` 已有：长目标直到完成，Ctrl+C 暂停；
- 之后：PR/CI 失败信号 → 新 run（`/autopilot` 等价物，依赖 orchestration 解冻范围）。

**验收**：一个必然失败的命令 + 修复脚本 → 循环按上限重试并在通过后停止；`Ctrl+C` 暂停可恢复。

## 3. 边界与不做什么

- **不做"模型自评即通过"**：L2 的评审者必须是独立上下文，且不参与写代码。
- **不做无限修复**：L1 一次、L2 一次/run、L3 三轮上限；任何超限都走诚实 FAIL 路径。
- **不做 silent autofix on unrelated files**：修复输入仅 findings 指向的文件与验收标准。
- **不把评审变成审批**：评审是证据，不是权限；写操作审批体系不变。
- **bench 影响**：L1 可能给"改完不检查"的样本加一轮，这是预期教学；用 bench A/B 观察
  PASS 率与平均 turn 变化，若 turn 成本 > 收益再考虑默认关闭开关。

## 4. 配置与开关（计划）

- `verificationGate: boolean`（默认 true）：L1 的逃生阀；关闭后行为等同今天之前。
- `review: { mode: 'off' | 'auto' | 'manual', depth: 'quick' | 'deep' }`（默认 auto/quick）。
- 全部走 config，不进提示词；`/config` 可见（手感要求）。

## 5. 实施切片与验收

| 片   | 内容                                               | 验收证据                                   | 状态                                                                 |
| ---- | -------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| P0-a | L1 完成门 + 确定性探针（verify stage）             | 探针断言 5 种输入；真实 `-p` 三组对照      | L1 已落地；探针待补                                                  |
| P0-b | L1 逃生阀 `verificationGate` + `/config` 可见      | 关闭后复现场景不拦截                       | 待做                                                                 |
| P1-a | reviewer 子代理 + 结构化 findings + `/review` 接入 | 植入缺陷 diff 必须被发现；干净 diff 不编造 | 已落地（含 `review.mode=auto`、untracked 文件、`moss review check`） |
| P1-b | L3 有界修复循环（上限 3，日志）                    | 两轮修复场景；三轮失败诚实清单             | 已落地（守护 + 3 轮边界）                                            |
| P2-a | `moss loop --until`（本地 CI 式闭环）              | 失败→修复→通过的循环记录                   | 待做                                                                 |
| P2-b | Stop hook recipe（用户可插拔完成门）               | 示例 hook 拦截未验证终稿                   | 待做                                                                 |

## 6. 与既有文档的关系

- 任务契约/证据/裁决：`AGENTS.md`「任务契约 / 证据 / 验收」；本 spec 不重复其机制，只补"非任务 run"与"独立评审"。
- Cursor 机制证据：`docs/research/2026-11-05-cursor-acceptance-loop.md`。
- 能力方向排队：`docs/specs/2026-11-04-moss-next-capabilities-brainstorm.md`（D5 orchestration、D9 rules 会为 L4/L2 提供输入）。
