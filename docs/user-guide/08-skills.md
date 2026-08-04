# Skills

A skill is a reusable way of working — a `SKILL.md` file with frontmatter
(name, trigger, tags) and a body of instructions. Skills are auto-matched to
the task each turn and injected into context when they apply; they are also
dispatchable as slash commands.

## Where skills live

| Location | Scope |
|---|---|
| `<project>/.moss/skills/<name>/SKILL.md` | project (checked into the repo) |
| `~/.config/moss/skills/<name>/SKILL.md` | user (all your projects) |
| bundled (builtin, RDK, ...) | shipped with moss |

List what's loaded in-session:

```sh
/skills
```

## Install a skill

In-session, the agent can install a SKILL.md directly:

```text
load_skill  name="react-testing"  skill_markdown="…"
  → writes packages/.../.moss/skills/react-testing/SKILL.md
```

SkillHub skills are discoverable and installable too:

```text
skillhub_search  query="code review"
skillhub_install code="deep-review"
load_skill       name="deep-review"
```

SkillHub CLI auto-installs on first use when missing.

## Enable / disable per session

```sh
/skill enable tdd          # re-enable auto-injection + /<name> dispatch
/skill disable mutation-fuzz   # stop auto-injection (in-memory, not persisted)
```

## Skill learning

Successful runs crystallize into SKILL.md files moss can reuse — when a
working method proves repeatedly useful, moss can distill it into a skill
(trigger conditions, steps, verification). Learned skills appear under
`.moss/skills/` and show up in `/skills`.

## Write your own

A minimal skill:

```markdown
---
name: commit-after-green
description: Commit only after tests pass.
trigger: [commit, ship, done]
tags: [git, workflow]
---

Before committing, run the targeted test suite and confirm green.
Then stage and commit with a message that says what changed and why.
```

Drop it in `<project>/.moss/skills/commit-after-green/SKILL.md` and it's
auto-discovered.

For ordered multi-skill selection, dependency metadata, model-free board
defaults, optional providers, and rollback, see the
[Adaptive Skill Composer](21-skill-composer.md).

See the [user-guide index](README.md) for other topics.

## 可执行恢复配方的运维流程

可信自进化不会把一段成功回答直接发布为 learned Skill。生产链路必须依次留下以下证据：

1. 同一 Skill、同一完整环境至少两次独立的 `failed -> recovered` 真机轨迹。
2. `RecoveryRecipe` 只能由白名单操作编译，必须包含前置检查、修复动作、不变量和终局检查；原始命令、stdout、主机地址和用户名不会复制进配方。
3. 内容过少、与基础 Skill 重复、只对单次环境成立、证据重复或含不安全操作的配方会保留审计记录，但不能发布。
4. 候选配方必须在不同 task/run/evidence 上完成一次 held-out Shadow 重放，之后才生成带 `TRUSTED-PATCH.json` 的 learned Skill。
5. 发布只代表“允许进入隔离 A/B”，并不代表已经激活。Control 不注入 learned guidance；Treatment 必须留下 assignment、exposure receipt、终局证据和成本记录。

实验前在 `.moss/evolution.json` 冻结假设和指标。例如，在成功率不劣于 Control 的前提下验证耗时优势：

```json
{
  "experiment": {
    "hypothesis": "success_noninferiority_cost_superiority",
    "costMetrics": ["durationMs"],
    "minSamplesPerArm": 20,
    "successNoninferiorityMargin": 0.05,
    "minCostImprovementRatio": 0.10,
    "minCostMetricsImproved": 1,
    "maxCostRatio": 1.20
  }
}
```

不要在看到中途结果后修改上述配置；assignment 会记录配置哈希，配置漂移会使样本失去资格。只有预注册假设、统计门槛、实际效果门槛、成本护栏、安全护栏和污染检查全部通过，Patch 才能从 `shadow` 变为 `active`。样本不足或效果不确定时保持 `shadow`；显著退化或出现安全失败时进入 `demoted`，并使用已保存的前一修订回滚。

排障时优先查看只读报告：

```text
/evolution status
/evolution experiments
/evolution patch <patchId>
/evolution config
```

常见拒绝原因应按 reason code 处理：先补独立恢复证据或 Shadow 重放，再重新启动全新的预注册实验；不要手工编辑 append-only 账本，也不要把旧实验的失败样本删除后重算。
## 可信自进化与实验状态

Moss 可以把同一 Skill、同一环境中由可信终局证据确认的“失败后恢复”沉淀为候选 learned Skill。候选达到独立 proof 门槛后才会发布；发布后的内容由实验协调器独占激活，普通 Skill 匹配和 `load_skill` 不会绕过 Control/Treatment 隔离。

使用以下只读命令查看状态：

```text
/evolution status
/evolution experiments
/evolution patch <patchId>
/evolution config
```

这些命令不会发布、激活、降级或回滚 Patch。报告只显示哈希身份、聚合指标和 reason code，不显示设备地址、用户名、原始探针结果、Prompt 或 stdout。

可选的工作区配置位于 `.moss/evolution.json`：

```json
{
  "experiment": {
    "minSamplesPerArm": 20,
    "wilsonZ": 1.96,
    "maxCostRatio": 1.2,
    "maxRetryIncrease": 0.25
  }
}
```

无效、越界或未知字段会产生诊断；对应值回退到保守默认值。设备任务只有在板型和 OS/BSP/固件版本身份完整时才可进入自动发布与 A/B，同一板卡刷写不同版本会形成不同环境指纹。

### 证据域、归因和 A/B 资格

- 新证据显式记录 `local`、`simulation` 或 `real`。设备 Skill 只有在真实设备身份完整且 `realEvidenceEligible=true` 时，才能增加发布、晋升或 A/B 的有效样本；仿真成功不会折算成真板置信度。
- 多 Skill Plan 的整体成功不会平均分功。只有新鲜 evidence 唯一映射到一个 Plan step，并且该 step 只有一个契约 Skill 所有者时，才以 `single-owner-step` 归因失败或恢复。
- treatment 必须有与 assignment、run、patch revision 和 guidance hash 匹配的上下文注入 receipt；control 必须证明没有 learned guidance。缺 receipt 或 control 污染的 outcome 会保留审计，但从统计中排除。
- 跨信号必须关联同一个 task/run/evidence，并来自不同观测组。例如执行 stdout 与产物 MIME/解码是两个通道；同一 stdout 加退出码仍属于同一执行组，不能冒充独立确认。

RDK X5 的安全真板回归已覆盖 `rdk-capture-photo`、`rdk-isp-tuning`、`rdk-hardware` 和 `rdk-command-manual`。默认回归只执行只读检查，拍照只在 `/tmp/photo.jpg` 写临时产物，不自动修改 ISP tuning 或系统配置。

### 进程失败与意向治疗统计

实验 outcome 不只看某次机器谓词是否曾经通过。若终局谓词通过后，CLI 仍被 completion gate 拒绝，或 Agent 因未完成 Plan、连续工具失败、超时而非零退出，运行器会把该 run 与 assignment、exposure receipt 和 v2 Experience 对齐，并追加 `outcomeSource=agent-process` 的失败 outcome。原始记录保留，但进程失败会覆盖该 run 的最终统计状态并留在成功率分母中，避免只统计“能够走到终局”的幸存样本。

实验维护或代码完整性修复导致的主动中断必须单独标为 `agent_process_interrupted_for_integrity_fix`，只作审计，不伪装成自然任务失败。最终报告应同时披露自然进程失败、维护中断、排除 run 和终局证据覆盖率。

### 2026-08-04 RDK X5 有效性证明

在可逆的 `/tmp/photo.jpg` 空目录占位冲突上，使用冻结的 `success_noninferiority_cost_superiority` 假设和 `toolCalls` 主成本指标完成了 20-Control/20-Treatment 真板实验。Control 为 18/20 成功，Treatment 为 20/20 成功；平均工具调用从 19.95 降至 14.60，下降 26.82%。平均耗时、输入 Token 和输出 Token 分别下降 18.71%、37.53% 和 19.76%，且没有安全失败或 Treatment 新失败类型。系统自动给出 `active (credible_cost_benefit_under_success_noninferiority)`。

完整的脱敏配置、结果、哈希和完整性检查见 [`docs/evidence/self-evolution-rdk-x5-actionable-recovery-2026-08-04.json`](../evidence/self-evolution-rdk-x5-actionable-recovery-2026-08-04.json)。这证明该恢复配方在该任务和环境上有用，不应外推为所有 Skill、设备或固件环境都已变强。
