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

See the [user-guide index](README.md) for other topics.
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
