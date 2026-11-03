# Read-only Completion Intent Implementation Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A successfully completed read-only request must not be marked incomplete merely because the user explicitly said not to modify files.

**Architecture:** Keep file-change intent in the existing `requestExpectsFileChanges` seam, shared by both completion evaluators. Remove explicitly negated mutation clauses before checking for positive change requests; preserve positive instructions in separate clauses and do not weaken safety blocks, failed checks, or genuine edit-task warnings.

**Tech Stack:** TypeScript, Node.js 22, existing CLI completion tracker and Node test runner.

---

### Task 1: Reproduce and fix the actual TUI finding

**Files:**

- Modify: `src/cli/run-completion.ts`
- Create: `test/run-completion-readonly-intent.spec.mjs`

- [ ] Add regression cases for `请读取当前目录的 README.md，并用一句中文概括，不要修改文件。`, English `read ...; do not edit files`, and Chinese / English requests that include both a positive fix and a separate negative constraint. Through `resolveRunOutcome`, assert read-only requests finish successfully and real fixes with no writes remain incomplete.
- [ ] Build and run `node --test test/run-completion-readonly-intent.spec.mjs`; confirm the read-only requests fail on the pre-fix implementation.
- [ ] Update `requestExpectsFileChanges` to remove explicitly negated file-change clauses before matching positive change verbs, preserving positive clauses after punctuation or an adversative. Rebuild and rerun the new and existing `o110-zh-en-claim-parity` and `run-completion-o98` tests.
- [ ] Repeat the original real-model, read-only TUI request in the isolated dogfood workspace; confirm the response no longer ends with a false incomplete message and no project files were changed.
