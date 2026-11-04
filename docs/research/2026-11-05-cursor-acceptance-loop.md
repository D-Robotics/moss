# Cursor 如何处理任务验收与持续闭环（调研）

日期：2026-11-05 · 目的：把"任务验收 + 持续闭环"这套机制拆清楚，再教给 Moss。
所有事实都标注来源；没读到的不猜。抓取时间为 2026-11-05，Cursor 文档仍在变动，实现前应重新核对。

## 1. 结论先行

Cursor 没有一个叫 "acceptance" 的单独模式。它的验收是**叠加在普通 agent loop 上的四层机制**：

| 层          | 机制                                                                                                                                 | 本质                                        | 证据                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L1 自检     | agent 在 loop 内"持续检查自己的工作、跑测试、修错误"                                                                                 | 提示词 + 工具（terminal）约定，不是独立功能 | [learn/agents](https://cursor.com/learn/agents.md)                                       |
| L2 独立评审 | Agent Review：对本地改动做专门 review，可配置为"每个任务后自动跑"；quick / deep 两档                                                 | 独立 review pass（非 agent 自评）           | [agent-review](https://cursor.com/docs/agent/agent-review.md)                            |
| L3 自动修复 | Bugbot：PR review 找问题 → "Fix in Cursor/Web"；bug 修复循环上限 3；CI check 用 `success` / `neutral` / `failure` 表达"有未解决问题" | 发现 → 修复 → 复检，有上限、有机器可读状态  | [bugbot](https://cursor.com/docs/bugbot.md) + 2026-11-04 清单 6.14                       |
| L4 持续闭环 | `/goal` 长目标"直到完全完成"，Ctrl+C 暂停；`/loop` 定时唤醒；`/autopilot` 云子代理接管 PR：处理反馈、冲突、失败的 checks             | 把外部信号（CI/PR/日程）接回 loop           | [agent/overview](https://cursor.com/docs/agent/overview.md)、2026-11-04 清单 6.13 / 5.14 |

配套的"不闭环就没法验收"的基础设施：**终端 + 可运行的测试环境**（云代理环境定义里明说"跑不了测试的 agent 关不上环"）、
**checkpoint 回滚**（自动快照，只回滚文件，不回滚消息）、**hooks 的 stop 钩子**（完成时观察/拦截）。

## 2. 逐条事实

### 2.1 L1：agent 自己检查

> "As it executes each step, it's constantly checking its work, running tests, and fixing any errors that pop up."
> — [learn/agents](https://cursor.com/learn/agents.md)

同一页也给了诚实的边界，这部分对 Moss 的"诚实报 FAIL"设计同样重要：

> "Agents ... can get stuck in loops, repeating the same failing approach without recognizing they need a different strategy."
> "you're still responsible for verifying the code works correctly and meets your standards."

结论：Cursor 没有把"自检"做成魔法，它是**工具（terminal/测试）+ 提示词**的约定；真正的兜底是 L2/L4 和人类。

### 2.2 L2：Agent Review（独立评审 pass）

> "Agent Review runs a dedicated code review on your local changes from inside Cursor."
> "You can set it to run automatically after every agent task, or leave it manual and trigger it yourself."
> "Automatic: When enabled in settings, Agent Review runs after every commit is made."
> "Slash command: Type `/agent-review` in the agent window input to trigger a review on demand."
> "Agent Review also reads repository rules from `BUGBOT.md` files."
> Quick / Deep 两档：Quick = 小 diff、快、便宜；Deep = 复杂逻辑/安全/大重构。
> — [agent-review](https://cursor.com/docs/agent/agent-review.md)

关键点：review 是**评审者与被评者分离**的（独立 pass，不是让写代码的同一轮说"我看过了"），并且
**可接在"每个任务/每个 commit 之后"自动触发**——这就是"验收"的位置：不是等用户点开 diff。

### 2.3 L3：Bugbot 的发现 → 修复 → 复检

> "Bugbot analyzes PR diffs and leaves comments with explanations and fix suggestions. It runs automatically on each PR update."
> "Uses existing PR comments as context: reads connected PR comments (top-level and inline) to avoid duplicate suggestions and build on prior feedback."
> "Fix in Cursor links open issues directly in Cursor / Fix in Web ... cursor.com/agents"
> CI statuses：`success` = 没发现问题且没有未解决的旧 Bugbot 评论；`neutral` = 发现了问题/被新提交取消/内部错误（默认）；`failure` = 发现问题且配置为未解决即失败。
> — [bugbot](https://cursor.com/docs/bugbot.md)

补充事实（2026-11-04 清单 6.14，来源同一文档族）：**autofix 循环上限 3**、PR 过大跳过、生成文件跳过、
已有评论去重。这些是"闭环不失控"的边界条件，比"能不能自动修"更值得抄。

### 2.4 L4：长目标与外部信号

> "Agent reads each message as a new job. Use `/goal` to give the agent a long-lived objective to work towards until it's fully complete."
> "In the CLI, Ctrl+C pauses the goal. Pair a goal with ... the built-in `/loop` skill to run a prompt or skill on a recurring or variable interval."
> — [agent/overview](https://cursor.com/docs/agent/overview.md)

> `/autopilot`：云子代理拥有一个 PR，处理 review 反馈、冲突、失败的 checks；Projects 的 Subscriptions 可监听 Slack/PR/CI/日程主动行动。
> — 2026-11-04 清单 6.13（[subagents](https://cursor.com/docs/subagents.md)、[agent/projects](https://cursor.com/docs/agent/projects.md)）

关键点：**持续闭环的燃料是外部信号**（CI 状态、PR 评论、schedule），而不是模型自己想不想继续。

### 2.5 完成时的确定性钩子：hooks 的 `stop`

> Agent hooks 包含 `stop` — "Handle agent completion"；命令 hook 退出码 `2` 等于 `permission: deny`；cloud agents 支持 `stop`。
> — [hooks](https://cursor.com/docs/hooks.md)

这是"在 agent 声称完成的那一刻插入验收逻辑"的官方位置。2026-11-04 清单 8.1.5–8.1.7 已记录其
matcher/timeout/failClosed/loop limit 语义，Moss 的 hooks 契约已对齐到同一事件模型（`Stop` 事件、13 个事件、fail-closed 开关）。

### 2.6 回滚与"错误的代价"

> Checkpoints：agent 在"significant changes"前自动快照，所有被改文件的状态；可从时间线任意 checkpoint 预览并恢复；
> 只恢复文件、不恢复消息；本地存储、与 git 分离；"Only use them for undoing Agent changes; use Git for permanent version control."
> — [agent/overview](https://cursor.com/docs/agent/overview.md)

验收失败要有"退回去重来"的成本保证，否则修复循环会越修越乱。

### 2.7 子代理：评审/探索的隔离

> 每个子代理独立上下文；foreground 阻塞返回 / background 立即返回；内置 Explore（更快模型、并行搜索）与 Browser；
> "Subagents start with a clean context. The parent agent includes relevant information in the prompt since subagents don't have access to prior conversation history."
> — [subagents](https://cursor.com/docs/subagents.md)

对验收的启示：**独立评审者天然适合做成子代理**（干净上下文，不被写代码那轮的自我辩护污染）。

## 3. Moss 现状对照（代码事实，2026-11-05）

| Cursor 机制                | Moss 现状                                                                                                | 差距                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| agent 自检（跑测试/复读）  | 有 `red-verify` nudge、`best-of-n`、`run_tests`；任务 run 有验收门                                       | **普通编码 run 没有"改完必须检查"的完成门**——今天补上      |
| 任务契约 → 证据 → 裁决     | Task Runtime 状态机 + `VerdictProvider` + `.moss/evidence.jsonl` + 修复循环（默认 5 次）、诚实 FAIL 路径 | 已强于 Cursor 文档可见部分；缺"独立评审"层                 |
| 独立评审 pass              | `/review` 命令（对 diff 做一次性 review 提示）                                                           | 不自动触发、不与验收标准比对、findings 不回灌修复循环      |
| 发现 → 修复 → 复检（上限） | 任务修复循环有 maxRepairAttempts / maxTurns；`red-verify` 有 best-of-n                                   | 缺 Bugbot 式"review findings 作为修复输入 + 复检 + 上限 3" |
| `/goal` 长目标             | 有 `/goal` + 验收门                                                                                      | 缺"外部信号唤醒"（CI/PR/schedule）                         |
| hooks `stop`               | 有 `Stop` 事件（13 事件之一）+ fail-closed                                                               | 缺现成 recipe/默认接线                                     |
| checkpoint 回滚            | `FileCheckpointStore` + `/rewind`                                                                        | 有，未与验收失败自动联动                                   |
| 子代理隔离评审             | `create_subagent` / fan_out / 专家注册表（verify scope 已有 record_evidence/task_acceptance）            | 缺"评审者"专用专家 + 验收标准注入                          |

## 4. 今天落地的那一片（L1 通用化）

新增 `src/core/loop/verification-completion-gate.ts`，接在任务验收门之后、宿主完成门之前：

- 触发条件：本次 run 调用了文件变更工具（write_file/edit_file/multi_edit/apply_patch/device_file_write），
  且**最后一次变更之后**没有任何检查动作（read_file/read-only 探测/run_tests/匹配 test|lint|build|verify 的命令/
  task_acceptance/record_evidence）。
- 动作：拦截一次终稿，注入"先检查真实结果，再报告；无法验证就明确说未验证以及原因"；
  最多拦截一次，绝不无限劫持。
- 诚实通道：终稿明确写"未验证/unverified"即放行——鼓励诚实而非表演式成功。

真实验证（临时工作区 + 真实模型）：

1. 指令故意禁止复读："Create a.txt ... Do NOT read it back, do NOT run any command, do not verify it."
   → 模型 `write_file` 后想收尾 → 门拦截 → 模型 `read_file`，终稿报告实际观察到的内容（"reading a.txt back shows exactly hi"）。
2. 对照组（诚实披露）："Do not read it back ... say explicitly that the change is unverified."
   → 只有 `write_file` 一次工具调用，终稿 "the change is unverified"，**没有被拦截**。
3. 纯问答（无变更）：不受影响。

## 5. 还欠什么（写进 spec 的后续片）

1. **L2 独立评审**：review 子代理 + 验收标准（acceptance criteria）作为评审 rubric；findings 结构化 → 自动进修复循环，上限 3。
2. **findings → 修复 → 复检** 的机器状态（类似 Bugbot 的 success/neutral/failure）。
3. **外部信号闭环**：`/autopilot` 等价物（CI/PR 失败信号 → 新 run），需要 orchestration（已解冻，范围见 brainstorm §5.1）。
4. **`stop` hook recipe**：把"完成门"变成用户可插拔的脚本契约（Moss 已有事件，缺文档与示例）。
5. **评审者专家**：verify scope 已能记录证据；再加 reviewer 角色（只读 diff + 评审输出），复用子代理隔离。

## 6. 参考

- https://cursor.com/learn/agents.md
- https://cursor.com/docs/agent/overview.md
- https://cursor.com/docs/agent/agent-review.md
- https://cursor.com/docs/bugbot.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/subagents.md
- https://cursor.com/docs/agent/prompting.md（自定义模式：把 workflow 类 skill 挂成模式，跨轮保持）
- 本仓库既有清单：`docs/research/2026-11-04-next-capabilities/cursor.md`
