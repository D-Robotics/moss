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
