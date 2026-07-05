# Design: moss Self-Iteration — Autonomous Loop + Observable Process

> Status: proposal (2026-07-05). P0 strategic direction.
> Goal: moss can run autonomously like a cron loop — self-schedule, self-review,
> self-fix, self-improve — with a highly observable process.

## 1. Vision

moss evolves from an "agent tool you drive" to an "agent platform that drives
itself." Two pillars:

- **Daily office/coding**: excellent at code review, test, fix, explore, document.
- **Board/device**: RDK X5/X3, ROS2, diagnostics, deployment.

The agent runs in a **continuous loop** (like our current cron-based loop),
reviewing code, finding issues, fixing them, verifying, and accumulating
skills/memory — all observable in real time.

## 2. What moss already has

| Capability | Status | Gap |
|---|---|---|
| `/goal` mode | ✅ exists | Basic — loops until goal condition, no scheduling |
| Subagent orchestration | ✅ create_subagent / fan_out | Good — but no auto-dispatch |
| Skill learning | ✅ ConversationSkillLearner | Half-closed loop — skills stored but matching is passive |
| Eval framework | ✅ eval tool + metrics | Basic — 6 string metrics, no LLM-judge |
| Plan-execute | ✅ plan / plan_step | Half-finished — no replan action exposed |
| Memory | ✅ MemoryManager + embeddings | Good — but no auto-sediment after each iteration |
| Session persistence | ✅ JSONL + resume | Good — but no auto-resume after crash |
| Mesh networking | ✅ AgentMesh | Opt-in, LAN-only |
| Teaching layer | ✅ annotations | Opt-in, off by default |

## 3. Core gaps for self-iteration

### 3.1 No built-in scheduler

moss has no `/loop` command or internal scheduler. The current approach relies
on external cron. For self-iteration, moss needs:

- A `/loop [interval] <prompt>` interactive command that self-schedules
- The loop runs the prompt, waits for completion, then re-schedules
- Observable: shows what was done, what's next, metrics
- Resumable: if moss crashes, `moss resume --last` continues the loop
- Bounded: max iterations, max duration, max token budget

**Design**: Add a `LoopScheduler` class to `core/loop/` that wraps `agent.chat()`:
```
LoopScheduler {
  intervalMs, maxIterations, maxDurationMs, maxTokens
  run(prompt) → schedules next run after completion + interval
  observable: emits progress events (iteration N, elapsed, tokens, findings)
  persistable: saves loop state to .moss/loop-state.json for resume
}
```

### 3.2 Process not observable

The agent's internal process (what it's thinking, what tools it called, what
it found, what it fixed) is not structured for external observation. The TUI
shows a live stream but there's no:

- Structured progress log (JSON, queryable)
- Iteration summary (what changed, what was verified, what's deferred)
- Metrics dashboard (commits, tests, findings, token usage)
- Diff log (what files changed in each iteration)

**Design**: Add a `LoopJournal` to `core/loop/`:
```
LoopJournal {
  log(iteration, summary, changes, metrics)
  serialize() → .moss/loop-journal.jsonl (one line per iteration)
  summarize() → markdown summary for the user
}
```

### 3.3 Harness not strong enough

For self-iteration on code, moss needs first-class engineering tools:

- **Code review tool**: `review_code` — runs a structured review (like our
  subagent reviews) and returns findings
- **Test runner tool**: `run_tests` — runs the test suite, parses results,
  identifies failures
- **Codebase explorer**: `explore_codebase` — structured exploration (like
  CodeGraph but also grep/rg-based)
- **Fix verifier**: `verify_fix` — runs build + test + typecheck after a change

Some of these exist (exec can run tests, CodeGraph can explore) but they're
not structured as **agent-friendly tools** that return parsed, actionable
output.

### 3.4 No iteration context management

Long-running loops accumulate context. moss has compaction, but for
self-iteration specifically:

- After each iteration, sediment key findings to memory
- Compact the conversation to a summary
- Start the next iteration with: summary + memory + new prompt
- This is different from per-turn compaction — it's iteration-level

**Design**: Add `iterationCompact()` to the loop:
```
After each iteration:
1. Extract key findings (what was reviewed, what was fixed, what's deferred)
2. Write to memory (long-term) + loop journal (structured)
3. Compact conversation to a 1-paragraph summary
4. Next iteration starts with: summary + relevant memories + new prompt
```

### 3.5 Self-improvement闭环不完整

Skills are learned but the loop doesn't:
- Automatically promote high-confidence skills
- Re-evaluate skills that turned out to be wrong
- Adjust its own behavior based on past iteration outcomes

**Design**: After each iteration, the loop should:
- Score the iteration (did it find real issues? did fixes pass tests?)
- If a pattern recurs (e.g., "always check for X in module Y"), auto-promote
- If a skill led to a wrong fix, demote it

## 4. Implementation plan (phased)

### Phase 1: LoopScheduler + LoopJournal (core self-iteration)
- `core/loop/loop-scheduler.ts` — schedules + runs + resumes
- `core/loop/loop-journal.ts` — structured iteration log
- `/loop [interval] <prompt>` command
- `moss resume --loop` to continue after crash
- Observable: TUI shows iteration N, elapsed, findings count

### Phase 2: Harness tools (engineering strength)
- `tools/review-code.ts` — structured code review tool (returns findings)
- `tools/run-tests.ts` — test runner with parsed output
- `tools/verify-fix.ts` — build + test + typecheck in one call
- These return structured output the LLM can act on

### Phase 3: Iteration context management
- `core/loop/iteration-compact.ts` — sediment findings to memory + compact
- Memory auto-write after each iteration
- Next iteration starts lean (summary + memories)

### Phase 4: Self-improvement loop
- Iteration scoring (did it find/fix real issues?)
- Skill auto-promote/demote based on iteration outcomes
- Pattern detection (recurring findings → skill candidate)

## 5. What to port from Pi

From the Pi comparison, these are most relevant for self-iteration:
- **Pi's agent-session architecture** (structured session + runtime + services)
  → moss's MossAgent is monolithic; Pi's layering is cleaner for long-running
- **Pi's event-bus** → decoupled progress events for observability
- **Pi's keybindings** → configurable for power users in long sessions
- **Pi's syntax highlighting** ✅ already ported
- **Pi's overflow patterns** ✅ already ported
- **Pi's JSON repair** ✅ already ported

## 6. Relationship to existing moss features

- `/goal` → LoopScheduler supersedes it (goal is a loop with a termination
  condition; loop is a goal with a schedule)
- Subagent orchestration → LoopScheduler can dispatch subagents per iteration
- Memory → LoopJournal writes to memory; iterations read from memory
- Skills → Phase 4 auto-promotes skills from iteration patterns
- Eval → can score iterations
- Plan-execute → each iteration can use plan-execute for complex tasks
