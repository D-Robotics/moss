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

当前自动归因只支持单 Skill。多 Skill 任务会保留整体终局记录，但不会把 proof 分摊给每个 Skill；仿真成功也不能替代真机 proof。
