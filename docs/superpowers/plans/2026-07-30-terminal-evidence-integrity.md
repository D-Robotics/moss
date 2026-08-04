# Terminal Evidence Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal process predicates consume structured tool execution evidence, persist failed terminal audits, and prevent retries over one execution from inflating drift or promotion proof counts.

**Architecture:** Add a small completion-gate evidence type and a pure extractor over session messages. Pass that evidence through terminal arbitration while leaving assistant prose available to the existing completion gates. Extend append-only terminal records with optional task/attempt/evidence identities, then deduplicate at aggregation time so both drift and promotion inherit the corrected statistics.

**Tech Stack:** TypeScript ESM, Node.js 22.16+, JSONL persistence, `.spec.mjs` tests using `node:assert`, npm workspaces.

## Global Constraints

- Follow test-first development: each behavior starts as a failing `.spec.mjs` assertion.
- Keep `terminal-verdicts.jsonl` append-only; do not rewrite existing user data.
- Preserve compatibility for callers and legacy records that lack new optional fields.
- Missing process evidence returns `unknown`; never use assistant prose as a fallback.
- File/device terminal predicates keep their existing objective data paths.
- Do not add predicates, board activation, T3.2 proposals, or contract materialization in this change.
- Run the repository gate `npm run verify` before completion.

---

## File Structure

- Modify `packages/moss-agent/src/cli/coding-completion-gate.ts`: define the completion-gate execution-evidence boundary and add it to the request.
- Create `packages/moss-agent/src/cli/terminal-execution-evidence.ts`: extract the latest completed `exec`/`exec_background` result from message history without consulting assistant prose.
- Modify `packages/moss-agent/src/core/loop/agent-loop-response.ts`: attach extracted execution evidence to the completion-gate request.
- Modify `packages/moss-agent/src/acceptance/task-terminal-verifier.ts`: feed structured stdout/exit status into process predicates and make absent evidence undecidable.
- Modify `packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts`: persist terminal verdicts before returning an audit failure and add task/attempt/evidence identities.
- Modify `packages/moss-agent/src/acceptance/terminal-verdict-log.ts`: accept optional identities and aggregate canonical, deduplicated proof records.
- Modify focused tests in `packages/moss-agent/test/`: lock down extraction, trusted evidence, record ordering, legacy compatibility, deduplication, candidate thresholds, and drift thresholds.

### Task 1: Extract Structured Terminal Execution Evidence

**Files:**
- Modify: `packages/moss-agent/src/cli/coding-completion-gate.ts:30`
- Create: `packages/moss-agent/src/cli/terminal-execution-evidence.ts`
- Create: `packages/moss-agent/test/terminal-execution-evidence.spec.mjs`
- Modify: `packages/moss-agent/src/core/loop/agent-loop-response.ts:276`

**Interfaces:**
- Produces: `TerminalExecutionEvidence { source: string; toolUseId?: string; exitCode?: number; stdout: string; stderr: string }`.
- Produces: `extractLatestTerminalExecutionEvidence(messages: Message[]): TerminalExecutionEvidence | undefined`.
- Extends: `CodingCompletionGateRequest.executionEvidence?: TerminalExecutionEvidence`.
- Consumes: session `Message[]` and existing `tool_use`/`tool_result` block fields.

- [ ] **Step 1: Write the failing extractor test**

Create `packages/moss-agent/test/terminal-execution-evidence.spec.mjs` with cases that prove assistant text is ignored, an `exec` result is selected, a later completed result wins, and a still-running background result is ignored:

```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { extractLatestTerminalExecutionEvidence } from '../dist/cli/terminal-execution-evidence.js';

const assistantClaimOnly = [
  { role: 'assistant', content: [{ type: 'text', text: 'exit_code: 0\ndeploy complete' }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(assistantClaimOnly), undefined);

const completedExec = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'exec', input: { command: 'deploy' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'exit_code: 0\ndeploy complete' }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(completedExec), {
  source: 'exec',
  toolUseId: 'tool-1',
  exitCode: 0,
  stdout: 'deploy complete',
  stderr: '',
});

const backgroundStillRunning = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-bg', name: 'exec_background', input: { command: 'npm test' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-bg', content: 'Started bg_123. Still running.' }] },
];
assert.equal(extractLatestTerminalExecutionEvidence(backgroundStillRunning), undefined);

const laterFailure = [
  ...completedExec,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'exec', input: { command: 'verify' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'exit_code: 2\nstdout: partial\nstderr: broken' }] },
];
assert.deepEqual(extractLatestTerminalExecutionEvidence(laterFailure), {
  source: 'exec',
  toolUseId: 'tool-2',
  exitCode: 2,
  stdout: 'partial',
  stderr: 'broken',
});

console.log('terminal execution evidence extraction passed');
```

- [ ] **Step 2: Build and run the new test to verify it fails**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-execution-evidence.spec.mjs
```

Expected: build or test fails because `terminal-execution-evidence` does not exist.

- [ ] **Step 3: Add the evidence type and extractor**

In `coding-completion-gate.ts`, export the type and add the optional request field:

```ts
export interface TerminalExecutionEvidence {
  source: string;
  toolUseId?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface CodingCompletionGateRequest {
  // existing fields
  executionEvidence?: TerminalExecutionEvidence;
}
```

Create `terminal-execution-evidence.ts`. Build a `toolUseId -> tool name` map, scan user `tool_result` blocks in order, accept only `exec` and `exec_background`, ignore still-running starts, and parse these exact result shapes:

```ts
const EXIT_LINE = /^\s*exit_code:\s*(-?\d+)\s*(?:\r?\n|$)/i;
const STDOUT_LINE = /^stdout:\s?(.*)$/im;
const STDERR_LINE = /^stderr:\s?(.*)$/im;
```

When the body begins with `exit_code`, remove that metadata line. If explicit `stdout:`/`stderr:` labels exist, use their captured values; otherwise treat the remaining body as stdout. Do not derive exit code from `is_error` or prose.

- [ ] **Step 4: Attach evidence in the agent loop**

Import the extractor in `agent-loop-response.ts` and extend the request:

```ts
const executionEvidence = extractLatestTerminalExecutionEvidence(currentMessages);
const decision = await completionGate({
  sessionKey,
  runId,
  turn: state.turns,
  response: state.finalText,
  ...(executionEvidence ? { executionEvidence } : {}),
  // existing fields
});
```

- [ ] **Step 5: Build and run the focused test**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-execution-evidence.spec.mjs
```

Expected: `terminal execution evidence extraction passed`.

- [ ] **Step 6: Commit the evidence boundary**

```bash
git add packages/moss-agent/src/cli/coding-completion-gate.ts packages/moss-agent/src/cli/terminal-execution-evidence.ts packages/moss-agent/src/core/loop/agent-loop-response.ts packages/moss-agent/test/terminal-execution-evidence.spec.mjs
git commit -m "feat(acceptance): bind terminal execution evidence"
```

### Task 2: Make Terminal Process Predicates Evidence-Only

**Files:**
- Modify: `packages/moss-agent/src/acceptance/task-terminal-verifier.ts:22`
- Modify: `packages/moss-agent/src/acceptance/predicate-evaluator.ts:17`
- Modify: `packages/moss-agent/test/task-terminal-verifier.spec.mjs`

**Interfaces:**
- Consumes: `TaskTerminalInput.executionEvidence?: TerminalExecutionEvidence` from Task 1.
- Extends: `PredicateEvalInput.exitCode?: number` so `exit_code_zero` never parses assistant prose.
- Preserves: file/device predicate evaluation without execution evidence.

- [ ] **Step 1: Add failing trusted-boundary tests**

Append focused cases to `task-terminal-verifier.spec.mjs`:

```js
const stdoutPlan = makePlan([{ name: 'stdout_matches', params: { pattern: 'DEPLOY_OK' } }]);
const assistantOnly = await verifyTaskTerminal({
  plan: stdoutPlan,
  workspaceDir: tmp,
  deviceExecutor: null,
  finalResponse: 'DEPLOY_OK',
});
assert.equal(assistantOnly.verdict, 'unknown', 'assistant prose is not terminal stdout evidence');

const stdoutEvidence = await verifyTaskTerminal({
  plan: stdoutPlan,
  workspaceDir: tmp,
  deviceExecutor: null,
  finalResponse: 'not trusted',
  executionEvidence: { source: 'exec', toolUseId: 'e1', exitCode: 0, stdout: 'DEPLOY_OK', stderr: '' },
});
assert.equal(stdoutEvidence.verdict, 'pass');

const exitPlan = makePlan([{ name: 'exit_code_zero', params: {} }]);
const noExitEvidence = await verifyTaskTerminal({
  plan: exitPlan,
  workspaceDir: tmp,
  deviceExecutor: null,
  finalResponse: 'exit_code: 0',
});
assert.equal(noExitEvidence.verdict, 'unknown');

const nonzeroEvidence = await verifyTaskTerminal({
  plan: exitPlan,
  workspaceDir: tmp,
  deviceExecutor: null,
  finalResponse: '',
  executionEvidence: { source: 'exec', toolUseId: 'e2', exitCode: 3, stdout: '', stderr: 'failed' },
});
assert.equal(nonzeroEvidence.verdict, 'fail');
```

Use the test file's existing plan factory or inline its actual plan shape if no factory exists.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/task-terminal-verifier.spec.mjs
```

Expected: assistant-only cases incorrectly pass or TypeScript rejects `executionEvidence`.

- [ ] **Step 3: Implement evidence-only predicate inputs**

In `predicate-evaluator.ts`, add `exitCode?: number` and replace the `exit_code_zero` branch with:

```ts
case 'exit_code_zero': {
  const exit = inp.exitCode;
  if (!Number.isInteger(exit)) {
    return { verdict: 'unknown', reasonCode: 'no_exit_code', confidence: 'low' };
  }
  return exit === 0
    ? { verdict: 'pass', reasonCode: 'exit_zero', evidence: { exitCode: 0 }, confidence: 'medium' }
    : { verdict: 'fail', reasonCode: 'nonzero_exit', evidence: { exitCode: exit }, confidence: 'medium' };
}
```

In `task-terminal-verifier.ts`, add `executionEvidence?: TerminalExecutionEvidence` and call `evaluatePostconditions` with:

```ts
result: input.executionEvidence?.stdout ?? '',
reportedIsError:
  input.executionEvidence?.exitCode !== undefined
    ? input.executionEvidence.exitCode !== 0
    : false,
exitCode: input.executionEvidence?.exitCode,
```

Before evaluating, if any terminal predicate is `stdout_matches` or `exit_code_zero` and `executionEvidence` is absent, return an `unknown` verdict with `reason: 'terminal execution evidence unavailable'` and `checkedCount` preserved. Do not block file-only contracts.

- [ ] **Step 4: Pass request evidence through arbitration**

In `terminal-arbitration-gate.ts`, replace the current `finalResponse`-only call with:

```ts
finalResponse: req.response,
executionEvidence: req.executionEvidence,
```

- [ ] **Step 5: Run terminal verifier and predicate tests**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/predicate-evaluator.spec.mjs
node packages/moss-agent/test/task-terminal-verifier.spec.mjs
```

Expected: both tests pass; file/device cases remain green and assistant-only process cases are `unknown`.

- [ ] **Step 6: Commit the trusted predicate boundary**

```bash
git add packages/moss-agent/src/acceptance/task-terminal-verifier.ts packages/moss-agent/src/acceptance/predicate-evaluator.ts packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts packages/moss-agent/test/task-terminal-verifier.spec.mjs
git commit -m "fix(acceptance): require objective terminal process evidence"
```

### Task 3: Persist Audit Failures Before Blocking

**Files:**
- Modify: `packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts:64`
- Modify: `packages/moss-agent/test/terminal-arbitration-gate.spec.mjs`

**Interfaces:**
- Consumes: `req.runId`, `req.turn`, and optional `req.executionEvidence`.
- Produces new optional record identities: `taskId`, `attemptId`, `evidenceId`.
- Preserves: one record per referenced skill and the existing correction response.

- [ ] **Step 1: Add a failing audit-record-order test**

Change the core audit-failure case to attach a `TerminalVerdictLog`, then assert the failure was persisted even though the wrapped gate returned `ok: false`:

```js
const tvLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'audit-fail-log') });
const wrapped = wrapWithTerminalArbitration(passthroughGate, {
  experienceLog: log,
  planProvider: { current: plan },
  deviceExecutor: { current: null },
  workspaceDir: tmp,
  terminalVerdictLog: tvLog,
});
const request = {
  sessionKey: 's1',
  runId: 'run-audit',
  turn: 2,
  response: 'done',
  messages: [],
  totalToolCalls: 1,
  toolCallsByName: {},
};
const result = await wrapped(request);
assert.equal(result.ok, false);
const [entry] = await tvLog.readAll();
assert.equal(entry.verdict, 'fail');
assert.equal(entry.taskId, plan.id);
assert.equal(entry.attemptId, `${plan.id}:s1:run-audit:2`);
```

- [ ] **Step 2: Run the gate test to verify it fails**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: no audit-failure record exists because the current return occurs before append.

- [ ] **Step 3: Move append before the audit return and add identities**

Extract the existing append block into a local helper inside `wrapWithTerminalArbitration` or move it directly above the audit-failure branch. New entries use:

```ts
const attemptId = `${plan.id}:${req.sessionKey}:${req.runId}:${req.turn}`;
const evidenceId = req.executionEvidence?.toolUseId;
await deps.terminalVerdictLog.append({
  id: `${attemptId}:${skill}`,
  taskId: plan.id,
  attemptId,
  ...(evidenceId ? { evidenceId } : {}),
  skill,
  verdict: terminal.verdict,
  reason: terminal.reason,
  sessionKey: req.sessionKey,
  timestamp: new Date().toISOString(),
});
```

Update the dependency interface so `append` accepts the optional identity fields. Do not add a second append after the audit branch.

- [ ] **Step 4: Run the gate test**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: all gate assertions pass, including audit-failure persistence.

- [ ] **Step 5: Commit the ordering fix**

```bash
git add packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
git commit -m "fix(acceptance): record failed terminal audits"
```

### Task 4: Deduplicate Terminal Proof at Read Time

**Files:**
- Modify: `packages/moss-agent/src/acceptance/terminal-verdict-log.ts:20`
- Modify: `packages/moss-agent/test/terminal-verdict-log.spec.mjs`

**Interfaces:**
- Extends: `TerminalVerdictEntry` with optional `taskId`, `attemptId`, `evidenceId`.
- Produces: `canonicalizeTerminalEntries(entries: TerminalVerdictEntry[]): TerminalVerdictEntry[]`.
- Changes: `aggregateTerminalBySkill` aggregates canonical entries, not raw lines.

- [ ] **Step 1: Add failing canonicalization and compatibility tests**

Append records covering same-attempt replacement, same-evidence retry, independent evidence, duplicate legacy IDs, and unknown accounting:

```js
const dedupEntries = [
  { id: 'a-old', taskId: 'p', attemptId: 'attempt-a', evidenceId: 'ev-1', skill: 'rdk-device', verdict: 'unknown', reason: 'pending', sessionKey: 's', timestamp: '2026-07-30T00:00:00.000Z' },
  { id: 'a-new', taskId: 'p', attemptId: 'attempt-a', evidenceId: 'ev-1', skill: 'rdk-device', verdict: 'pass', reason: 'ok', sessionKey: 's', timestamp: '2026-07-30T00:01:00.000Z' },
  { id: 'b', taskId: 'p', attemptId: 'attempt-b', evidenceId: 'ev-1', skill: 'rdk-device', verdict: 'pass', reason: 'retry same proof', sessionKey: 's', timestamp: '2026-07-30T00:02:00.000Z' },
  { id: 'c', taskId: 'p', attemptId: 'attempt-c', evidenceId: 'ev-2', skill: 'rdk-device', verdict: 'fail', reason: 'new proof', sessionKey: 's', timestamp: '2026-07-30T00:03:00.000Z' },
  { id: 'legacy-1', skill: 'legacy', verdict: 'pass', reason: 'old', sessionKey: 's', timestamp: '2026-07-29T00:00:00.000Z' },
  { id: 'legacy-1', skill: 'legacy', verdict: 'pass', reason: 'duplicate old', sessionKey: 's', timestamp: '2026-07-29T00:01:00.000Z' },
];
const dedupStats = aggregateTerminalBySkill(dedupEntries);
assert.equal(dedupStats.get('rdk-device').proofCount, 2, 'ev-1 and ev-2 are two independent proofs');
assert.equal(dedupStats.get('rdk-device').pass, 1);
assert.equal(dedupStats.get('rdk-device').fail, 1);
assert.equal(dedupStats.get('legacy').proofCount, 1, 'duplicate legacy id collapses');
```

- [ ] **Step 2: Run the log test to verify proof counts are inflated**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-verdict-log.spec.mjs
```

Expected: `rdk-device.proofCount` is greater than 2 and legacy proof count is 2.

- [ ] **Step 3: Implement deterministic canonicalization**

Add optional fields to `TerminalVerdictEntry`. Implement two passes:

```ts
export function canonicalizeTerminalEntries(entries: TerminalVerdictEntry[]): TerminalVerdictEntry[] {
  const byAttempt = new Map<string, { entry: TerminalVerdictEntry; index: number }>();
  entries.forEach((entry, index) => {
    const attemptKey = entry.attemptId ? `${entry.skill}:attempt:${entry.attemptId}` : `${entry.skill}:legacy:${entry.id}`;
    const previous = byAttempt.get(attemptKey);
    if (!previous || isLater(entry, index, previous.entry, previous.index)) {
      byAttempt.set(attemptKey, { entry, index });
    }
  });

  const byEvidence = new Map<string, { entry: TerminalVerdictEntry; index: number }>();
  for (const value of byAttempt.values()) {
    const entry = value.entry;
    const evidenceKey = entry.evidenceId ? `${entry.skill}:evidence:${entry.evidenceId}` : `${entry.skill}:record:${entry.attemptId ?? entry.id}`;
    const previous = byEvidence.get(evidenceKey);
    if (!previous || isLater(entry, value.index, previous.entry, previous.index)) {
      byEvidence.set(evidenceKey, value);
    }
  }
  return [...byEvidence.values()].sort((a, b) => a.index - b.index).map((value) => value.entry);
}
```

`isLater` compares valid `Date.parse(timestamp)` values first; equal or invalid timestamps use the later input index. Filter entries whose `id` or `skill` is missing before inserting them. Update `aggregateTerminalBySkill` to iterate over `canonicalizeTerminalEntries(entries)`.

- [ ] **Step 4: Run log and candidate tests**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-verdict-log.spec.mjs
node packages/moss-agent/test/promotion-candidate-source.spec.mjs
```

Expected: both pass; old unique IDs still count independently.

- [ ] **Step 5: Commit canonical proof aggregation**

```bash
git add packages/moss-agent/src/acceptance/terminal-verdict-log.ts packages/moss-agent/test/terminal-verdict-log.spec.mjs
git commit -m "fix(acceptance): deduplicate terminal proof statistics"
```

### Task 5: Prove Candidate and Drift Thresholds Use Independent Evidence

**Files:**
- Modify: `packages/moss-agent/test/promotion-candidate-source.spec.mjs`
- Modify: `packages/moss-agent/test/task-terminal-verifier.spec.mjs`

**Interfaces:**
- Consumes: deduplicated `aggregateTerminalBySkill` from Task 4.
- Verifies: `createTerminalCandidateSource` and terminal drift calibration inherit corrected `proofCount` without production API changes.

- [ ] **Step 1: Add a candidate-threshold regression test**

In `promotion-candidate-source.spec.mjs`, append ten records with distinct attempts but one shared evidence ID, then assert a ten-proof threshold remains locked:

```js
const retryLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'same-evidence-retries') });
for (let i = 0; i < 10; i += 1) {
  await retryLog.append({
    id: `retry-${i}`,
    taskId: 'plan-retry',
    attemptId: `attempt-${i}`,
    evidenceId: 'tool-use-one',
    skill: 'rdk-device',
    verdict: 'pass',
    reason: 'same execution replayed',
    sessionKey: 's',
    timestamp: `2026-07-30T00:${String(i).padStart(2, '0')}:00.000Z`,
  });
}
const retrySource = createTerminalCandidateSource({ terminalVerdictLog: retryLog, minProofCount: 10 });
assert.deepEqual(await retrySource(makeCompletion()), [], 'one execution replayed ten times cannot unlock promotion');
```

Use the test file's existing completion request fixture rather than introducing a second shape.

- [ ] **Step 2: Add a drift cold-start regression test**

In `task-terminal-verifier.spec.mjs`, create ten same-evidence records and enough single-step experiences, then assert `driftChecks` remains empty because deduplicated proof count is one:

```js
const retryOnlyLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'drift-same-evidence') });
for (let i = 0; i < 10; i += 1) {
  await retryOnlyLog.append({
    id: `d-${i}`,
    taskId: 'p',
    attemptId: `a-${i}`,
    evidenceId: 'same-tool-result',
    skill: 'rdk-device',
    verdict: 'fail',
    reason: 'same failure replayed',
    sessionKey: 's',
    timestamp: `2026-07-30T01:${String(i).padStart(2, '0')}:00.000Z`,
  });
}
const retryDrift = await arbitrateTaskTerminal({
  plan: passingTerminalPlan,
  experiences: stepPassExperiences,
  workspaceDir: tmp,
  deviceExecutor: null,
  finalResponse: '',
  terminalVerdictLog: retryOnlyLog,
  minDriftSamples: 10,
});
assert.deepEqual(retryDrift.arbitration.driftChecks, []);
```

Reuse the file's existing plan and experience fixtures with the required skill.

- [ ] **Step 3: Run both tests**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/promotion-candidate-source.spec.mjs
node packages/moss-agent/test/task-terminal-verifier.spec.mjs
```

Expected: both pass because production sources already call `aggregateTerminalBySkill`.

- [ ] **Step 4: Commit threshold regressions**

```bash
git add packages/moss-agent/test/promotion-candidate-source.spec.mjs packages/moss-agent/test/task-terminal-verifier.spec.mjs
git commit -m "test(acceptance): guard terminal proof thresholds"
```

### Task 6: Verify the Full Change and Update the Roadmap

**Files:**
- Modify: `docs/self-evolution-loop.md`
- Verify: all files changed in Tasks 1-5

**Interfaces:**
- Documents: terminal statistics now count independent evidence and terminal process predicates no longer consume model text.
- Produces: repository-wide green verification evidence.

- [ ] **Step 1: Run the focused acceptance suite**

Run:

```bash
npm run build --workspace @rdk-moss/agent
node packages/moss-agent/test/terminal-execution-evidence.spec.mjs
node packages/moss-agent/test/predicate-evaluator.spec.mjs
node packages/moss-agent/test/task-terminal-verifier.spec.mjs
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
node packages/moss-agent/test/terminal-verdict-log.spec.mjs
node packages/moss-agent/test/promotion-candidate-source.spec.mjs
node packages/moss-agent/test/promotion-coordinator.spec.mjs
```

Expected: every process exits 0 and prints its success banner.

- [ ] **Step 2: Run package tests**

Run:

```bash
npm test --workspace @rdk-moss/agent
```

Expected: package test runner reports no failures. Real-board tests may explicitly skip when the board is unavailable; record that distinction.

- [ ] **Step 3: Run the repository verification gate**

Run:

```bash
npm run verify
```

Expected: formatting/lint, typecheck, build, and test stages pass with exit code 0.

- [ ] **Step 4: Update the roadmap with evidence and remaining scope**

In `docs/self-evolution-loop.md`, add a dated T3.3/T3.4 note stating:

```markdown
- 2026-07-30: terminal process predicates now consume structured execution evidence rather than assistant response text; audit failures are recorded before blocking; terminal proof aggregation deduplicates repeated attempts/evidence while reading legacy append-only logs. This repairs the statistical root for drift calibration and promotion. Physical cross-signal activation and T3.2 proposal lifecycle remain separate follow-up work.
```

Also correct any nearby statement that still claims terminal stdout comes from model text or that raw JSONL line count equals proof count.

- [ ] **Step 5: Check the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only the intended source, tests, plan/spec, and roadmap are changed; `git diff --check` is silent.

- [ ] **Step 6: Commit the verified roadmap update**

```bash
git add docs/self-evolution-loop.md
git commit -m "docs: close terminal evidence integrity gap"
```

- [ ] **Step 7: Record final verification metadata**

Run:

```bash
git status --short --branch
git log -7 --oneline --decorate
```

Expected: clean working tree on `feature/self-evolution-verifier`; recent commits correspond to the evidence boundary, predicate trust fix, audit logging, deduplication, threshold tests, and roadmap update.
