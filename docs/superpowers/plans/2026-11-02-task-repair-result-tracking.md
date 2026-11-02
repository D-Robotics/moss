# Task Repair Result Tracking Implementation Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Base repair guidance on successful results belonging to the failed task, and recognize attributable command verdicts.

**Architecture:** Parse the first line of acceptance results in one shared helper. Correlate calls and results by ID, use result order, and count only successful repair records for the relevant task. Command verdicts lack a task ID and are attributed only when the call explicitly provides one; preserve the existing SDK and tool execution paths.

**Tech Stack:** TypeScript, Node.js, existing Moss test runner.

---

### Implementation and validation

**Files:** `src/core/loop/acceptance-verdict-text.ts`, `src/core/loop/acceptance-completion-gate.ts`, `src/core/loop/nudges/task-repair-nudge.ts`, `test/acceptance-completion-gate.spec.mjs`, `test/task-repair-nudge.spec.mjs`, `test/task-tools-runtime.spec.mjs`.

- [ ] Cover failed and missing results, same-batch ordering, unrelated evidence, partial verdicts and misleading command output using the existing tests and a real acceptance command.
- [ ] Parse contract verdicts from the first line and command verdicts only with an explicit task ID. Ignore command output after its authoritative first line.
- [ ] Correlate successful repair results with their task; do not let rejected or unassigned records count as progress. Keep the completion gate soft and preserve the existing attempt limits.
- [ ] Run targeted tests, then `npm run verify` under Node 22. Check `git diff --check` and the final worktree status.

### Follow-up: implicit task selection

`task_acceptance` permits omitting `task_id`, but command verdict text has no task identity. When that combination is used, prefix the existing detail with `Task acceptance (<resolved task ID>): PASS|FAIL`, derived from the verdict before any command output. Calls with an explicit ID keep their existing output. The end-to-end command test exercises a failed verdict and a subsequent pass with no `task_id`, ensuring the nudge and completion gate attribute both to the actual task.
