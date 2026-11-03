# Moss Product Experience Improvement Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everyday interaction easier to understand, more responsive, and more trustworthy without removing capabilities.

**Architecture:** Simplify default help while preserving full help and configurable keys. Reuse one lazy workspace index while typing mentions. Keep tool transcript rows append-only and identify interleaved results by call ID; do not fold failures or running calls. Distinguish a running tool from a quiet provider before suggesting a gateway problem.

**Tech Stack:** TypeScript, Ink, existing PTY and Node.js tests.

---

### Implementation and verification

**Files:** `src/cli/first-run.ts`, `src/cli/cli-locale.ts`, `src/cli/tui/app-helpers.ts`, `src/cli/tui/help.ts`, `src/cli/tui/app.ts`, `src/cli/tui/render-bridge.ts`, `src/cli/tui/transcript.ts`, `src/cli/tui/projection-cache.ts`, `src/cli/tui/copy.ts`, and the existing TUI specs under `test/`.

- [ ] Preserve current user work in an isolated worktree and measure the actual terminal experience with the local stub.
- [ ] Add focused regressions for repeated mention indexing, interleaved tool results and error visibility, compact help with customized keys, and quiet-tool wording; observe the pre-fix failures.
- [ ] Keep the highlighted model visible in a height-bounded first-run list; preserve readline behavior.
- [ ] If a steer cannot be stored, keep its draft and report the failure; allow file completion while a run is active.
- [ ] Fix the identified causes with small changes. Preserve full help, command behavior, tool error details, and keyboard customization.
- [ ] Run focused TUI tests, exercise the resulting CLI in a PTY at normal and narrow sizes, and run `npm run verify` with Node 22 and the real macOS Git on PATH. Check final diff and integrate back into the current workspace.
