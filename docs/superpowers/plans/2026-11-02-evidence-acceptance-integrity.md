# Evidence Acceptance Integrity Implementation Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a task cannot be accepted from a missing observation or a conflicting evidence verdict while preserving the ability to evaluate a raw observation against a task criterion.

**Architecture:** Keep `evaluateExpectation` as the single comparison implementation for evidence recording and task acceptance. Treat missing observations and malformed numeric inputs as indeterminate at that seam. Preserve the caller's explicit verdict and the original automatic result in new evidence, and make acceptance respect known conflicts while still evaluating independent raw observations against task criteria. Older records do not preserve the source of an inconclusive verdict: when a legacy inconclusive result differs from a determinate re-evaluation, ask for remeasurement, while acknowledging that other ambiguous historical conflicts cannot be reconstructed. Exercise the public task tools and the existing durable evidence store end to end.

**Tech Stack:** TypeScript, Node.js 22, Node's built-in test runner, existing Moss task tools and JSONL artifact store.

---

### Task 1: Missing observations cannot satisfy an acceptance criterion

**Files:**

- Modify: `src/contracts/evidence.ts`
- Test: `test/evidence-model.spec.mjs`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Add a failing end-to-end test.** Define a task with criterion `{ metric: 'log', expected: 'not-contains CRITICAL' }`, record evidence with the same expectation and no observation, and assert the evidence is `INCONCLUSIVE` and task acceptance is `FAIL` with `NO EVIDENCE`. Use the existing `taskDefineTool`, `recordEvidenceTool`, `taskAcceptanceTool`, and temporary-workspace pattern in `test/task-contract.spec.mjs`.

- [x] **Step 2: Run the regression against the pre-fix build.** Run `node --test --test-name-pattern='missing observation cannot satisfy' test/task-contract.spec.mjs`. Expected: FAIL because the old implementation reports `PASS`.

- [x] **Step 3: Centralize the missing-observation check.** After parsing the comparator in `evaluateExpectation`, return an inconclusive evaluation when `observed` is undefined, retaining the documented existing `exists` failure semantics:

```ts
if (observed === undefined && comparator !== 'exists') {
  return {
    comparator: comparator || '==',
    result: 'inconclusive',
    explanation: 'no observation given',
  };
}
```

- [x] **Step 4: Rebuild and rerun.** Run `npm run build` and the command from step 2. Expected: PASS.

### Task 2: Malformed numeric values do not silently become zero

**Files:**

- Modify: `src/contracts/evidence.ts`
- Test: `test/evidence-model.spec.mjs`

- [x] **Step 1: Add one comparator regression.** Assert `evaluateExpectation('==0', '').result` and `evaluateExpectation('>=0', '  ').result` are `inconclusive`; assert real `0`, `'0'`, and `false` retain their existing observable semantics.
- [x] **Step 2: Run the test and observe the pre-fix failure.** Run `node --test --test-name-pattern='empty numeric observation' test/evidence-model.spec.mjs`. Expected: FAIL because `Number('')` is zero.
- [x] **Step 3: Reject blank numeric input.** Use a non-exported numeric conversion that returns `NaN` for blank strings and otherwise delegates to `Number`; use it for numeric observations and numeric operands in `evaluateExpectation`, preserving string comparisons where the operand is not numeric.
- [x] **Step 4: Rebuild and rerun the test.** Expected: PASS, with meaningful numeric zero and false observations preserved.

### Task 3: An explicitly conflicting verdict cannot be silently accepted

**Files:**

- Modify: `src/contracts/task.ts`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Add a failing end-to-end test.** Define a `>=30` criterion, record `observed: '31'`, `expected: '>=30'`, `result: 'fail'`; confirm the record is `INCONCLUSIVE` and assert the task is not accepted. Record a later consistent observation and assert a subsequent acceptance succeeds.
- [x] **Step 2: Run the pre-fix test.** Run `node --test --test-name-pattern='conflicting evidence blocks acceptance' test/task-contract.spec.mjs`. Expected: FAIL because the old acceptance code disregards the stored inconclusive result.
- [x] **Step 3: Respect conflicting verdicts at the acceptance seam.** Persist the optional `explicitResult` and `automaticResult` on new evidence. If an explicit verdict conflicts with or leaves its check inconclusive, keep the criterion unaccepted and retain the evidence ID with an explanation. For older inconclusive rows, a determinate re-evaluation is treated conservatively because provenance is unavailable; independent re-evaluation remains possible when the old recorded check is itself inconclusive. Do not reject a raw observation merely because it had no expectation at record time.
- [x] **Step 4: Rebuild and rerun.** Expected: PASS, including repair followed by successful remeasurement.

### Task 4: Select the newest observation deterministically

**Files:**

- Modify: `src/contracts/task.ts`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Reproduce equal-timestamp ordering.** Pass `[newer, older]` evidence with identical timestamps, as returned by `listEvidenceRecords`, and check both PASS→FAIL and FAIL→PASS sequences.
- [x] **Step 2: Run the regression.** Run `node --test --test-name-pattern='same-timestamp evidence' test/task-contract.spec.mjs`; the old implementation chooses the older row.
- [x] **Step 3: Keep the first row for a timestamp tie.** Update the latest-per-metric condition from `record.timestamp >= existing.timestamp` to `record.timestamp > existing.timestamp`; document the newest-first tie convention on `evaluateAcceptance`.
- [x] **Step 4: Rebuild and rerun.** Both directions must select the newer row.

### Task 5: Do not lose task evidence behind another task's history

**Files:**

- Modify: `src/core/task-runtime/artifacts.ts`
- Modify: `src/core/task/verdict.ts`
- Modify: `src/core/task/task-store.ts`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Reproduce the global evidence limit.** Define a task, record its passing observation, append 1,001 valid observations for other task IDs to the same workspace, and assert the original task can still be accepted.
- [x] **Step 2: Run the regression.** Run `node --test --test-name-pattern='other tasks cannot hide evidence' test/task-contract.spec.mjs`; the previous implementation reads only the latest 1,000 workspace-wide records and reports no evidence.
- [x] **Step 3: Read evidence by task before applying display limits.** Add an internal `listTaskEvidenceRecords(workspaceDir, taskId)` in the existing artifact store that reads `evidence.jsonl`, filters by the exact task ID, and returns matching rows newest-first. Reuse it for contract evaluation and task snapshots; keep the existing bounded public list and UI list semantics.
- [x] **Step 4: Rebuild and rerun.** The original task must pass with the correct recorded observation; command-based verdict authority remains unchanged.

### Task 6: Keep earlier task IDs addressable

**Files:**

- Modify: `src/core/task-runtime/artifacts.ts`, `src/core/task/verdict.ts`, `src/core/task/task-store.ts`, `src/tools/task-tools.ts`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Reproduce the global task list limit.** Define a task, record its passing observation, append 51 other distinct task contracts, and explicitly accept the first task. Assert the verdict is PASS instead of `task not found`.
- [x] **Step 2: Run the regression.** Run `node --test --test-name-pattern='older task remains addressable' test/task-contract.spec.mjs`; the previous implementation limits internal lookups to 50 tasks.
- [x] **Step 3: Separate complete internal lookup from bounded listing.** Extract `listAllTaskRecords(workspaceDir)` in the existing artifact store, use it for task-ID operations and snapshots, and keep `listTaskRecords(workspaceDir, limit = 50)` bounded for its existing SDK and presentation callers.
- [x] **Step 4: Rebuild and rerun.** The first task remains addressable, and default listing still returns at most 50 distinct tasks.

### Task 7: Empty contracts cannot pass through the shared evaluator

**Files:**

- Modify: `src/contracts/task.ts`
- Test: `test/task-contract.spec.mjs`

- [x] **Step 1: Reproduce through the persisted contract interface.** Append a task contract with no criteria and invoke `evaluateContractAcceptance` directly; assert that its verdict is FAIL and the task is not marked accepted.
- [x] **Step 2: Run the regression.** Run `node --test --test-name-pattern='empty contract cannot pass' test/task-contract.spec.mjs`; the old shared evaluator returns PASS.
- [x] **Step 3: Guard the shared verdict.** In `evaluateAcceptance`, return `fail` when `task.acceptanceCriteria.length === 0`; keep the existing provider's explicit explanatory message and command-verdict authority.
- [x] **Step 4: Rebuild and rerun.** The direct persisted contract call and existing command verdict tests must pass.

### Task 8: Verify integration and preserve existing contracts

**Files:**

- Inspect: `src/core/task/verdict.ts`, `src/tools/evidence-tools.ts`, `src/core/task-runtime/artifacts.ts`
- Test: `test/evidence-model.spec.mjs`, `test/task-contract.spec.mjs`, `test/task-tools-runtime.spec.mjs`, and affected CLI task tests.

- [ ] Run the focused evidence and task tests after a fresh build under Node 22.
- [ ] Run the CLI smoke and `npm run verify` in this isolated worktree, never alongside another build in this same worktree.
- [ ] Review the complete diff for public SDK changes, existing user changes, accurate acceptance messages, and backward compatibility of persisted evidence.
- [ ] Record the actual test results and any remaining limitations before integrating the branch into `main`.
