# T3.4 Promotion Gate Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Observe successful CLI completions, evaluate only explicitly supplied L2 promotion candidates through the existing D6 dual-threshold gate, and emit decisions without affecting completion.

**Architecture:** Add a candidate-native `PromotionCoordinator<TCompletion>` that owns candidate discovery, statistics lookup, independent verification, and decision delivery. Add a non-blocking completion-gate wrapper and a pure CLI composition helper that fixes the order as coding gate -> terminal arbitration -> promotion observation.

**Tech Stack:** TypeScript 5.7, Node.js 22.16+, ESM, compiled `dist`, `node:test`, `node:assert/strict`, npm workspaces.

## Global Constraints

- Promotion remains observational: it must never reject or alter primary completion.
- Failed or correction-bound completions must not query promotion candidates.
- Missing candidates or statistics must not fabricate a decision.
- Statistical and cross-signal rejection decisions must reach the sink when statistics exist.
- Ordinary terminal success is not independent cross-signal confirmation.
- Production candidate discovery is intentionally empty in this slice.
- Do not call `aggregateBySkill()` from runtime promotion wiring.
- Do not derive candidates from `ExperienceLog`, `ObservationStats.skill`, `diagnostics.contractSkill`, generic L2 Experience rows, or existing L1 contract statistics.
- Do not mutate `ACCEPTANCE.json`, `ContractRegistry`, or any L1 contract.
- Preserve candidate identity through `PromotionCandidate.id`; adapt the existing skill-based verifier only inside the coordinator.

---

## File Map

**Create:**

- `packages/moss-agent/src/acceptance/promotion-coordinator.ts` - candidate-native orchestration and per-dependency failure isolation.
- `packages/moss-agent/src/core/tools/promotion-completion-gate.ts` - successful-completion observer wrapper.
- `packages/moss-agent/src/cli/completion-gate-composition.ts` - pure CLI wrapper ordering.
- `packages/moss-agent/test/promotion-coordinator.spec.mjs` - coordinator behavior and identity tests.
- `packages/moss-agent/test/promotion-completion-gate.spec.mjs` - wrapper behavior tests.
- `packages/moss-agent/test/cli-completion-gate-composition.spec.mjs` - terminal/promotion order integration tests.

**Modify:**

- `packages/moss-agent/src/cli-main.ts` - construct late-bound promotion dependencies and use tested composition helper.
- `docs/self-evolution-loop.md` - mark the honest runtime skeleton complete and retain real candidate lifecycle as follow-up.

**Intentionally unchanged:**

- `packages/moss-agent/src/acceptance/promotion-gate.ts` - continue reusing `evaluatePromotion()`.
- `packages/moss-agent/src/memory/observation-aggregator.ts` - do not use its L1 `contractSkill` aggregation for candidates.
- `packages/moss-agent/src/index.ts` and package exports - keep this transitional runtime API internal.
- Existing acceptance contracts and registries - no materialization or mutation.

---

### Task 1: Candidate-Native Promotion Coordinator

**Files:**

- Create: `packages/moss-agent/test/promotion-coordinator.spec.mjs`
- Create: `packages/moss-agent/src/acceptance/promotion-coordinator.ts`
- Reuse: `packages/moss-agent/src/acceptance/promotion-gate.ts:51`

**Interfaces:**

- Consumes: `ObservationStats`, `PromotionDecision`, `PromotionGateThresholds`, and `evaluatePromotion()`.
- Produces: `PromotionCandidate`, `PromotionCoordinatorDeps<TCompletion>`, `PromotionDecisionRecord`, and `PromotionCoordinator<TCompletion>.observeCompletion(completion): Promise<void>`.

- [ ] **Step 1: Write the failing coordinator tests**

Create fixtures and tests with the following shape in `promotion-coordinator.spec.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { PromotionCoordinator } from '../dist/acceptance/promotion-coordinator.js';

const candidate = (id, targetSkill = 'rdk-device') => ({
  id,
  targetSkill,
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'test-fixture',
    proposalRef: `proposal://${id}`,
  },
});

const stats = (skill, proofCount, successRate) => ({
  skill,
  proofCount,
  passCount: Math.round(proofCount * successRate),
  failCount: proofCount - Math.round(proofCount * successRate),
  unknownCount: 0,
  successRate,
  averageConfidence: 0.9,
  signalSources: ['tool_exit'],
});
```

Cover these exact behaviors:

```js
await test('empty candidate source is a no-op', async () => {
  let downstreamCalls = 0;
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [],
    statsSource: () => {
      downstreamCalls += 1;
    },
    crossSignalVerifier: () => {
      downstreamCalls += 1;
      return true;
    },
    decisionSink: () => {
      downstreamCalls += 1;
    },
  });
  await coordinator.observeCompletion({ sessionKey: 's1' });
  assert.equal(downstreamCalls, 0);
});

await test('missing statistics emits no fabricated decision', async () => {
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => undefined,
    crossSignalVerifier: () => true,
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.deepEqual(records, []);
});

await test('statistical rejection skips cross-signal verification and reaches sink', async () => {
  let verifierCalls = 0;
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: () => [candidate('a')],
    statsSource: () => stats('rdk-device', 9, 1),
    crossSignalVerifier: () => {
      verifierCalls += 1;
      return true;
    },
    decisionSink: (record) => records.push(record),
  });
  await coordinator.observeCompletion({});
  assert.equal(verifierCalls, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.promotable, false);
  assert.equal(records[0].decision.statisticalPassed, false);
});
```

Also add tests for:

- statistical pass plus cross-signal failure -> one non-promotable record;
- both gates pass -> one promotable record;
- candidate-source failure resolves without throwing;
- stats-source failure continues to the next candidate;
- verifier failure continues to the next candidate;
- sink failure continues to the next candidate;
- two candidates sharing `targetSkill` receive different outcomes based on their IDs, proving the verifier receives the full candidate rather than `stats.skill`.

For failure tests, temporarily capture `process.stderr.write` and assert a warning is emitted for each injected dependency failure.

- [ ] **Step 2: Run the red test**

Run:

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-coordinator.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/acceptance/promotion-coordinator.js`.

- [ ] **Step 3: Implement the coordinator interfaces**

Create `promotion-coordinator.ts` with these public types:

```ts
import { errorMessage } from '../errors.js';
import { getRootLogger } from '../logger.js';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import {
  evaluatePromotion,
  type PromotionDecision,
  type PromotionGateThresholds,
} from './promotion-gate.js';

const log = getRootLogger().child('acceptance:promotion');

export interface PromotionCandidateProvenance {
  layer: 'L2';
  kind: 'explicit-proposal';
  source: string;
  proposalRef: string;
}

export interface PromotionCandidate {
  id: string;
  targetSkill: string;
  provenance: PromotionCandidateProvenance;
}

export type PromotionCandidateSource<TCompletion> = (
  completion: TCompletion
) => readonly PromotionCandidate[] | Promise<readonly PromotionCandidate[]>;

export type PromotionStatsSource = (
  candidate: PromotionCandidate
) => ObservationStats | undefined | Promise<ObservationStats | undefined>;

export type CandidateCrossSignalVerifier = (
  candidate: PromotionCandidate
) => boolean | Promise<boolean>;

export interface PromotionDecisionRecord {
  candidate: PromotionCandidate;
  decision: PromotionDecision;
}

export type PromotionDecisionSink = (record: PromotionDecisionRecord) => void | Promise<void>;

export interface PromotionCoordinatorDeps<TCompletion> {
  candidateSource: PromotionCandidateSource<TCompletion>;
  statsSource: PromotionStatsSource;
  crossSignalVerifier: CandidateCrossSignalVerifier;
  decisionSink: PromotionDecisionSink;
}

export interface PromotionCoordinatorOptions {
  thresholds?: PromotionGateThresholds;
}
```

- [ ] **Step 4: Implement failure-isolated observation**

Implement `PromotionCoordinator<TCompletion>` so each boundary is isolated:

```ts
export class PromotionCoordinator<TCompletion> {
  constructor(
    private readonly deps: PromotionCoordinatorDeps<TCompletion>,
    private readonly options: PromotionCoordinatorOptions = {}
  ) {}

  async observeCompletion(completion: TCompletion): Promise<void> {
    let candidates: readonly PromotionCandidate[];
    try {
      candidates = await this.deps.candidateSource(completion);
    } catch (error) {
      log.warn('promotion candidate discovery failed', { error: errorMessage(error) });
      return;
    }

    for (const candidate of candidates) {
      let stats: ObservationStats | undefined;
      try {
        stats = await this.deps.statsSource(candidate);
      } catch (error) {
        log.warn('promotion statistics lookup failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
        continue;
      }
      if (!stats) continue;

      let decision: PromotionDecision;
      try {
        decision = await evaluatePromotion(
          stats,
          () => this.deps.crossSignalVerifier(candidate),
          this.options.thresholds
        );
      } catch (error) {
        log.warn('promotion candidate evaluation failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
        continue;
      }

      try {
        await this.deps.decisionSink({ candidate, decision });
      } catch (error) {
        log.warn('promotion decision delivery failed', {
          candidateId: candidate.id,
          error: errorMessage(error),
        });
      }
    }
  }
}
```

Do not import `ExperienceLog`, `aggregateBySkill`, `ObservationAggregator`, or `ContractRegistry`.

- [ ] **Step 5: Build and run focused tests**

Run:

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/promotion-coordinator.spec.mjs
node packages/moss-agent/test/promotion-gate.spec.mjs
node packages/moss-agent/test/u5-trust-root-counterexample.spec.mjs
```

Expected: all subtests pass and each process exits `0`.

- [ ] **Step 6: Commit the coordinator**

```bash
git add packages/moss-agent/src/acceptance/promotion-coordinator.ts packages/moss-agent/test/promotion-coordinator.spec.mjs
git commit -m "feat(acceptance): add candidate-native promotion coordinator"
```

---

### Task 2: Non-Blocking Completion Observer Wrapper

**Files:**

- Create: `packages/moss-agent/test/promotion-completion-gate.spec.mjs`
- Create: `packages/moss-agent/src/core/tools/promotion-completion-gate.ts`

**Interfaces:**

- Consumes: the existing `CodingCompletionGateRequest` and `CodingCompletionGateResult` union.
- Produces: `PromotionCompletionObserver<TCompletion>` and `wrapWithPromotionObservation(originalGate, observer)`.

- [ ] **Step 1: Write the failing wrapper tests**

Use `node:test` and assert these behaviors:

```js
await test('rejected gate result bypasses promotion and preserves identity', async () => {
  const result = { ok: false, reason: 'not done', correction: 'continue' };
  let calls = 0;
  const wrapped = wrapWithPromotionObservation(async () => result, {
    observeCompletion: async () => {
      calls += 1;
    },
  });
  assert.equal(await wrapped(request), result);
  assert.equal(calls, 0);
});

await test('successful gate is observed once and preserves identity', async () => {
  const result = { ok: true };
  let observed;
  const wrapped = wrapWithPromotionObservation(async () => result, {
    observeCompletion: async (completion) => {
      observed = completion;
    },
  });
  assert.equal(await wrapped(request), result);
  assert.equal(observed, request);
});
```

Also verify:

- an observer throw/rejection logs a warning but returns the original `{ ok: true }` object;
- an original-gate throw still rejects and never runs the observer.

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-completion-gate.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/core/tools/promotion-completion-gate.js`.

- [ ] **Step 3: Implement the wrapper**

Create:

```ts
import type {
  CodingCompletionGateRequest,
  CodingCompletionGateResult,
} from '../../cli/coding-completion-gate.js';
import { errorMessage } from '../../errors.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('acceptance:promotion-completion');

export type CodingCompletionGate = (
  request: CodingCompletionGateRequest
) => Promise<CodingCompletionGateResult>;

export interface PromotionCompletionObserver<TCompletion> {
  observeCompletion(completion: TCompletion): Promise<void>;
}

export function wrapWithPromotionObservation(
  originalGate: CodingCompletionGate,
  observer: PromotionCompletionObserver<CodingCompletionGateRequest>
): CodingCompletionGate {
  return async (request) => {
    const result = await originalGate(request);
    if (!result.ok) return result;

    try {
      await observer.observeCompletion(request);
    } catch (error) {
      log.warn('promotion observation failed', { error: errorMessage(error) });
    }
    return result;
  };
}
```

Do not catch errors from `originalGate`.

- [ ] **Step 4: Run focused tests**

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/promotion-completion-gate.spec.mjs
node packages/moss-agent/test/promotion-coordinator.spec.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit the wrapper**

```bash
git add packages/moss-agent/src/core/tools/promotion-completion-gate.ts packages/moss-agent/test/promotion-completion-gate.spec.mjs
git commit -m "feat(acceptance): observe promotion after successful completion"
```

---

### Task 3: CLI Composition and Empty Production Candidate Source

**Files:**

- Create: `packages/moss-agent/test/cli-completion-gate-composition.spec.mjs`
- Create: `packages/moss-agent/src/cli/completion-gate-composition.ts`
- Modify: `packages/moss-agent/src/cli-main.ts:36`
- Modify: `packages/moss-agent/src/cli-main.ts:637`
- Modify: `packages/moss-agent/src/cli-main.ts:667`
- Modify: `packages/moss-agent/src/cli-main.ts:827`

**Interfaces:**

- Consumes: `wrapWithTerminalArbitration()`, `wrapWithPromotionObservation()`, a coding gate, terminal dependencies, and a promotion observer.
- Produces: `composeCliCompletionGate(codingGate, deps)` and stable CLI runtime wiring.

- [ ] **Step 1: Write the failing composition tests**

Create two behavioral tests using the established fixtures from `terminal-arbitration-gate.spec.mjs`:

1. An executing plan whose terminal artifact is absent plus all-pass session Experiences:
   - terminal arbitration returns `{ ok: false }`;
   - the coding gate is not called;
   - promotion observation is not called.
2. No active plan plus an accepting coding gate:
   - coding gate is called;
   - promotion observation runs once afterward;
   - the original successful object is preserved by identity.

Import the target as:

```js
import { composeCliCompletionGate } from '../dist/cli/completion-gate-composition.js';
```

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/cli-completion-gate-composition.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/cli/completion-gate-composition.js`.

- [ ] **Step 3: Implement the pure composition helper**

Create:

```ts
import type {
  CodingCompletionGateRequest,
  CodingCompletionGateResult,
} from './coding-completion-gate.js';
import {
  wrapWithTerminalArbitration,
  type TerminalArbitrationGateDeps,
} from '../core/tools/terminal-arbitration-gate.js';
import {
  wrapWithPromotionObservation,
  type PromotionCompletionObserver,
} from '../core/tools/promotion-completion-gate.js';

export type CliCompletionGate = (
  request: CodingCompletionGateRequest
) => Promise<CodingCompletionGateResult>;

export interface CliCompletionGateCompositionDeps {
  terminalArbitration: TerminalArbitrationGateDeps;
  promotionObserver: PromotionCompletionObserver<CodingCompletionGateRequest>;
}

export function composeCliCompletionGate(
  codingGate: CliCompletionGate,
  deps: CliCompletionGateCompositionDeps
): CliCompletionGate {
  return wrapWithPromotionObservation(
    wrapWithTerminalArbitration(codingGate, deps.terminalArbitration),
    deps.promotionObserver
  );
}
```

This exact nesting makes promotion the outer observer while requiring terminal and coding success first.

- [ ] **Step 4: Run the composition test green**

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/cli-completion-gate-composition.spec.mjs
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: both suites pass.

- [ ] **Step 5: Add late-bound coordinator dependencies in `cli-main.ts`**

Import `PromotionCoordinator`, `PromotionCoordinatorDeps`, `CodingCompletionGateRequest`, and `composeCliCompletionGate`. Beside the existing T3.3 refs, create:

```ts
const promotionRefs: Partial<PromotionCoordinatorDeps<CodingCompletionGateRequest>> = {};

const promotionCoordinator = new PromotionCoordinator<CodingCompletionGateRequest>({
  candidateSource: (completion) => promotionRefs.candidateSource?.(completion) ?? [],
  statsSource: (candidate) => promotionRefs.statsSource?.(candidate),
  crossSignalVerifier: (candidate) => promotionRefs.crossSignalVerifier?.(candidate) ?? false,
  decisionSink: (record) => promotionRefs.decisionSink?.(record),
});
```

Replace the inline terminal wrapper with:

```ts
completionGate: composeCliCompletionGate(
  createCliCompletionGate({ /* retain existing options unchanged */ }),
  {
    terminalArbitration: terminalArbitrationDeps,
    promotionObserver: promotionCoordinator,
  },
),
```

During the same CLI initialization phase as the terminal refs, assign only conservative production dependencies:

```ts
promotionRefs.candidateSource = () => [];
promotionRefs.statsSource = () => undefined;
promotionRefs.crossSignalVerifier = () => false;
promotionRefs.decisionSink = () => {};
```

Do not connect `ExperienceLog`, `aggregateBySkill`, `ObservationAggregator`, or terminal success to these refs.

- [ ] **Step 6: Build and run completion regressions**

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/cli-completion-gate-composition.spec.mjs
node packages/moss-agent/test/promotion-completion-gate.spec.mjs
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
node packages/moss-agent/test/coding-completion-gate.spec.mjs
```

Expected: terminal rejection cannot trigger promotion; accepted composed gates do; prior gate suites pass.

- [ ] **Step 7: Commit CLI wiring**

```bash
git add packages/moss-agent/src/cli/completion-gate-composition.ts packages/moss-agent/test/cli-completion-gate-composition.spec.mjs packages/moss-agent/src/cli-main.ts
git commit -m "feat(acceptance): wire T3.4 promotion observation into CLI runtime"
```

---

### Task 4: Documentation and Full Verification

**Files:**

- Modify: `docs/self-evolution-loop.md:479`
- Inspect only: `packages/moss-agent/package.json`
- Inspect only: `packages/moss-agent/src/index.ts`

**Interfaces:**

- Consumes: the completed runtime skeleton and its tests.
- Produces: an accurate roadmap entry and verified branch state.

- [ ] **Step 1: Update the T3.4 roadmap entry**

State explicitly that:

- D6 dual-threshold pure logic is implemented;
- the non-blocking runtime observer is wired after successful completion gates;
- production candidate discovery is intentionally empty;
- persisted L2 candidate lifecycle, candidate-level aggregation, independent attestation storage, review, and contract materialization remain follow-up work.

Do not claim that real L2-to-L1 promotion is complete.

- [ ] **Step 2: Verify no L1 aggregation shortcut exists**

```bash
rg -n "aggregateBySkill|contractSkill|ObservationAggregator" packages/moss-agent/src/cli-main.ts packages/moss-agent/src/acceptance/promotion-coordinator.ts packages/moss-agent/src/cli/completion-gate-composition.ts
```

Expected: no matches.

- [ ] **Step 3: Run focused regressions**

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/promotion-coordinator.spec.mjs
node packages/moss-agent/test/promotion-completion-gate.spec.mjs
node packages/moss-agent/test/cli-completion-gate-composition.spec.mjs
node packages/moss-agent/test/promotion-gate.spec.mjs
node packages/moss-agent/test/u5-trust-root-counterexample.spec.mjs
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
node packages/moss-agent/test/coding-completion-gate.spec.mjs
```

Expected: every process exits `0`.

- [ ] **Step 4: Run package verification**

```bash
npm run typecheck -w @rdk-moss/agent
npm test -w @rdk-moss/agent
```

Expected: TypeScript reports no errors and every package `*.spec.mjs` passes. If the known pre-existing Windows `coding-completion-gate.spec.mjs` EBUSY occurs, record the exact failure and separately prove all changed/new suites pass; do not misreport the package run as green.

- [ ] **Step 5: Run formatting and workspace verification**

```bash
npm run format:check
npm run verify
```

Expected: formatting, boundaries, hygiene, benchmark checks, build, typecheck, lint, and workspace tests pass. Report any pre-existing EBUSY separately and faithfully.

- [ ] **Step 6: Perform semantic review**

Confirm all statements are true:

- `candidateSource` is the only candidate entry point.
- Every candidate is explicitly L2 and has a stable ID and proposal reference.
- Stats and cross-signal sources receive the full candidate.
- The `evaluatePromotion()` adapter closes over the candidate and does not infer identity from `stats.skill`.
- Empty production discovery remains empty even when L1 Experience data exists.
- Terminal success permits observation but never counts as independent verification.
- Terminal or coding rejection prevents candidate discovery.
- Missing statistics creates no fabricated rejection.
- Promotion rejection never becomes completion rejection.
- Sink failure cannot consume a completion retry.
- No L1 contract or registry changed.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/self-evolution-loop.md
git commit -m "docs(acceptance): record honest T3.4 runtime boundary"
```

- [ ] **Step 8: Request code review before completion**

Invoke `superpowers:requesting-code-review`, address verified findings, rerun affected tests, then invoke `superpowers:verification-before-completion` before reporting completion.
