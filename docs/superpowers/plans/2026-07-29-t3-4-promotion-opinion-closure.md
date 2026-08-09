# T3.4 Promotion Closure (Opinion Sink) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the T3.4 promotion loop actually run — a real candidate flows through the four coordinator seams, `evaluatePromotion` produces a real decision, and the decision lands as a persisted `trust=observation` Opinion, while production cross-signal verification stays conservative (no auto-promotion).

**Architecture:** Add an append-only terminal-verdict log that records each task's terminal pass/fail tagged by skill (the trusted-root-safe data source). A candidate source aggregates that log per skill and emits a candidate when terminal passes cross `minProofCount`. A terminal-only stats source feeds `evaluatePromotion`. The decision sink writes one `trust=observation` Opinion via `MemoryManager`. Production `crossSignalVerifier` stays `() => false`. Wire all four into the existing `promotionRefs` in `cli-main.ts`.

**Tech Stack:** TypeScript 5.7, Node.js 22.16+, ESM, compiled `dist`, `node:test`, `node:assert/strict`, npm workspaces.

## Global Constraints

- Promotion is observational: never reject or alter primary completion.
- The candidate source must read **terminal hard-signal** statistics, never `aggregateBySkill`'s `contractSkill` path. The verifier must not judge its own success as a promotion basis (D5 trusted-root boundary).
- Production `crossSignalVerifier` is `() => false` (layer-3 geometry not wired). A statistics-passing candidate therefore always gets `non-promotable`. The loop runs; it does not auto-promote (D6: correlation ≠ correctness).
- Do NOT mutate any `ACCEPTANCE.json`, `ContractRegistry`, or L1 contract. The sink writes one Opinion memory entry only.
- Missing terminal signal (no plan / no `terminalAccept`) → no candidates, safe no-op.
- Existing `promotion-coordinator`, `promotion-completion-gate`, `cli-completion-gate-composition`, `objective-verifier-hook`, and typecheck suites must remain green.

---

## File Map

**Create:**

- `packages/moss-agent/src/acceptance/terminal-verdict-log.ts` — append-only terminal-verdict store (per skill), the trusted-root-safe statistic source.
- `packages/moss-agent/src/acceptance/promotion-candidate-source.ts` — aggregate terminal-verdict log per skill, emit candidates above threshold.
- `packages/moss-agent/src/acceptance/promotion-opinion-sink.ts` — write one `trust=observation` Opinion per decision.
- `packages/moss-agent/test/terminal-verdict-log.spec.mjs`
- `packages/moss-agent/test/promotion-candidate-source.spec.mjs`
- `packages/moss-agent/test/promotion-opinion-sink.spec.mjs`

**Modify:**

- `packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts` — write a terminal verdict to the log on each audited completion (only when a plan + skill tagging is available).
- `packages/moss-agent/src/cli-main.ts` — construct a `terminalVerdictLog`, wire real candidate/stats/sink into `promotionRefs` (keep `crossSignalVerifier = () => false`).
- `docs/self-evolution-loop.md` — mark the T3.4 Opinion-sink closure as running.

**Intentionally unchanged:**

- `packages/moss-agent/src/acceptance/promotion-coordinator.ts` — already correct; reuse as-is.
- `packages/moss-agent/src/acceptance/promotion-gate.ts` — reuse `evaluatePromotion()`.
- `packages/moss-agent/src/memory/observation-aggregator.ts` — NOT used by promotion wiring (L1 path, forbidden).
- `packages/moss-agent/src/cli/completion-gate-composition.ts` — already wires the order; unchanged.

---

### Task 1: Terminal-Verdict Log (Trusted-Root-Safe Statistic Source)

**Files:**

- Create: `packages/moss-agent/src/acceptance/terminal-verdict-log.ts`
- Create: `packages/moss-agent/test/terminal-verdict-log.spec.mjs`

**Interfaces:**

- Produces: `TerminalVerdictEntry { id, skill, verdict: 'pass'|'fail'|'unknown', reason, sessionKey, timestamp }`, `TerminalVerdictLog` class with `append(entry): Promise<void>` and `readAll(): Promise<TerminalVerdictEntry[]>`, and `aggregateTerminalBySkill(entries): Map<string, ObservationStats>`.

- [ ] **Step 1: Write the failing test**

Create `test/terminal-verdict-log.spec.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  TerminalVerdictLog,
  aggregateTerminalBySkill,
} from '../dist/acceptance/terminal-verdict-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tvlog-'));
const log = new TerminalVerdictLog({ baseDir: tmp });

// append-only, three-state verdict
await log.append({
  id: '1',
  skill: 'rdk-device',
  verdict: 'pass',
  reason: 'file_exist ok',
  sessionKey: 's1',
  timestamp: '2026-07-29T00:00:00.000Z',
});
await log.append({
  id: '2',
  skill: 'rdk-device',
  verdict: 'pass',
  reason: 'file_exist ok',
  sessionKey: 's1',
  timestamp: '2026-07-29T00:01:00.000Z',
});
await log.append({
  id: '3',
  skill: 'rdk-device',
  verdict: 'fail',
  reason: 'product missing',
  sessionKey: 's2',
  timestamp: '2026-07-29T00:02:00.000Z',
});

const all = await log.readAll();
assert.equal(all.length, 3, 'append-only, all entries kept');
assert.equal(all[0].skill, 'rdk-device');

// aggregation per skill (terminal signal, NOT contractSkill)
const stats = aggregateTerminalBySkill(all);
const dev = stats.get('rdk-device');
assert.ok(dev);
assert.equal(dev.skill, 'rdk-device');
assert.equal(dev.proofCount, 3); // pass+fail decided
assert.equal(dev.pass, 2);
assert.equal(dev.fail, 1);
assert.equal(dev.successRate, 2 / 3);

// unknown does not count toward proofCount (undecided = not evidence)
await log.append({
  id: '4',
  skill: 'rdk-ros',
  verdict: 'unknown',
  reason: 'no terminalAccept',
  sessionKey: 's3',
  timestamp: '2026-07-29T00:03:00.000Z',
});
const stats2 = aggregateTerminalBySkill(await log.readAll());
const ros = stats2.get('rdk-ros');
assert.equal(ros.proofCount, 0, 'unknown-only skill has 0 proof (not evidence)');

// reject non-three-state verdict (trusted-root: terminal signal must be objective)
let threw = false;
try {
  await log.append({
    id: '5',
    skill: 'x',
    verdict: 'maybe',
    reason: 'r',
    sessionKey: 's',
    timestamp: 't',
  });
} catch {
  threw = true;
}
assert.ok(threw, 'non-three-state verdict rejected');

await fs.rm(tmp, { recursive: true, force: true });
console.log(
  '✅ terminal-verdict-log: append-only + per-skill terminal aggregation + verdict validation'
);
```

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/terminal-verdict-log.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/acceptance/terminal-verdict-log.js`.

- [ ] **Step 3: Implement the log**

Create `src/acceptance/terminal-verdict-log.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import { memoryWarn } from '../memory/logger.js';

/**
 * 终局硬信号日志(append-only)— T3.4 候选触发的可信根安全统计源。
 *
 * 记录每个任务终态判定(Plan.terminalAccept 产物级硬信号)按 skill 标记,
 * 供 promotion candidateSource 聚合。关键:这是**任务级终态**信号,不是
 * 验证器自报的 contractSkill pass(D5:验证器不得用自报成败作为升层依据,
 * 那是循环)。终态判定读最终产物内容(客观硬信号,非模型文本)。
 *
 * 复用 ExperienceLog 的设计:append-only JSONL,串行写,失败只 warn 不抛
 * (副作用式,不影响主流程)。
 *
 * 见 docs/self-evolution-loop.md §5.3 / D1 / D6 / T3.4 closure spec。
 */

export interface TerminalVerdictEntry {
  id: string;
  skill: string;
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  sessionKey: string;
  timestamp: string;
}

export interface TerminalVerdictLogOptions {
  baseDir: string;
  filename?: string;
}

export class TerminalVerdictLog {
  private readonly filePath: string;
  private readonly chain = Promise.resolve();

  constructor(opts: TerminalVerdictLogOptions) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'terminal-verdicts.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async append(entry: TerminalVerdictEntry): Promise<void> {
    if (entry.verdict !== 'pass' && entry.verdict !== 'fail' && entry.verdict !== 'unknown') {
      throw new Error(
        `TerminalVerdictLog.append: verdict must be pass/fail/unknown, got ${String(entry.verdict)}`
      );
    }
    this.chain = this.chain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
      } catch (err) {
        memoryWarn('terminal verdict log append failed:', err);
      }
    });
    return this.chain;
  }

  async readAll(): Promise<TerminalVerdictEntry[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const out: TerminalVerdictEntry[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed));
        } catch {
          /* skip malformed */
        }
      }
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      memoryWarn('terminal verdict log read failed:', err);
      return [];
    }
  }
}

/**
 * 按终局信号聚合(每个 skill 的任务级终态 pass/fail/unknown)。
 * proofCount = pass+fail(decided);unknown 不计(未判定不算证据)。
 * 这与 aggregateBySkill 的 contractSkill 路径完全独立 —— 这里统计的是
 * 任务终局硬信号,不是验证器自报的契约 verdict。
 */
export function aggregateTerminalBySkill(
  entries: TerminalVerdictEntry[]
): Map<string, ObservationStats> {
  const bySkill = new Map<string, ObservationStats>();
  for (const e of entries) {
    let stats = bySkill.get(e.skill);
    if (!stats) {
      stats = {
        skill: e.skill,
        total: 0,
        pass: 0,
        fail: 0,
        unknown: 0,
        successRate: 0,
        proofCount: 0,
        failureReasons: {},
      };
      bySkill.set(e.skill, stats);
    }
    stats.total += 1;
    if (e.verdict === 'pass') stats.pass += 1;
    else if (e.verdict === 'fail') {
      stats.fail += 1;
      const reason = e.reason || 'unknown_reason';
      stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
    } else stats.unknown += 1;
  }
  for (const stats of bySkill.values()) {
    const decided = stats.pass + stats.fail;
    stats.successRate = decided > 0 ? stats.pass / decided : 0;
    stats.proofCount = decided;
  }
  return bySkill;
}
```

- [ ] **Step 4: Run the test green**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/terminal-verdict-log.spec.mjs
```

Expected: `✅ terminal-verdict-log ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/moss-agent/src/acceptance/terminal-verdict-log.ts packages/moss-agent/test/terminal-verdict-log.spec.mjs
git commit -m "feat(acceptance): terminal-verdict log — trusted-root-safe promotion statistic source"
```

---

### Task 2: Promotion Candidate Source (Terminal-Signal Trigger)

**Files:**

- Create: `packages/moss-agent/src/acceptance/promotion-candidate-source.ts`
- Create: `packages/moss-agent/test/promotion-candidate-source.spec.mjs`

**Interfaces:**

- Consumes: `TerminalVerdictLog.readAll()`, `aggregateTerminalBySkill()`, `PromotionGateThresholds` (default `minProofCount=10`), `PromotionCandidate`/`PromotionCandidateProvenance` (from `promotion-coordinator.ts`).
- Produces: `createTerminalCandidateSource(deps): PromotionCandidateSource<CodingCompletionGateRequest>` where `PromotionCandidateSource<TCompletion>` is `(completion) => readonly PromotionCandidate[] | Promise<readonly PromotionCandidate[]>`.

- [ ] **Step 1: Write the failing test**

Create `test/promotion-candidate-source.spec.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { createTerminalCandidateSource } from '../dist/acceptance/promotion-candidate-source.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-cand-'));
const log = new TerminalVerdictLog({ baseDir: tmp });

// skill with 10 terminal passes -> candidate
for (let i = 0; i < 10; i++) {
  await log.append({
    id: String(i),
    skill: 'rdk-device',
    verdict: 'pass',
    reason: 'ok',
    sessionKey: 's',
    timestamp: 't',
  });
}
// skill with 5 passes -> below threshold -> no candidate
for (let i = 0; i < 5; i++) {
  await log.append({
    id: `b${i}`,
    skill: 'rdk-ros',
    verdict: 'pass',
    reason: 'ok',
    sessionKey: 's',
    timestamp: 't',
  });
}

const candidateSource = createTerminalCandidateSource({
  terminalVerdictLog: log,
  minProofCount: 10,
});
const candidates = await candidateSource({
  sessionKey: 's',
  runId: 'r',
  turn: 1,
  response: '',
  messages: [],
  totalToolCalls: 0,
  toolCallsByName: {},
});

assert.equal(candidates.length, 1, 'only rdk-device crosses threshold');
assert.equal(candidates[0].targetSkill, 'rdk-device');
assert.equal(candidates[0].provenance.layer, 'L2');
assert.equal(candidates[0].provenance.kind, 'explicit-proposal');
assert.equal(candidates[0].provenance.source, 'terminal-hard-signal');
assert.match(candidates[0].id, /^term_rdk-device$/);

// idempotent: re-evaluating the same window yields the same id (not a flood)
const candidates2 = await candidateSource({
  sessionKey: 's',
  runId: 'r',
  turn: 1,
  response: '',
  messages: [],
  totalToolCalls: 0,
  toolCallsByName: {},
});
assert.equal(candidates2[0].id, candidates[0].id, 'idempotent id across re-evaluation');

// no terminal signal at all -> no candidates
const emptyLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'empty') });
const emptySource = createTerminalCandidateSource({
  terminalVerdictLog: emptyLog,
  minProofCount: 10,
});
const none = await emptySource({
  sessionKey: 's',
  runId: 'r',
  turn: 1,
  response: '',
  messages: [],
  totalToolCalls: 0,
  toolCallsByName: {},
});
assert.deepEqual(none, []);

await fs.rm(tmp, { recursive: true, force: true });
console.log(
  '✅ promotion-candidate-source: terminal-signal trigger above threshold, idempotent, no-signal no-op'
);
```

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-candidate-source.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/acceptance/promotion-candidate-source.js`.

- [ ] **Step 3: Implement the candidate source**

Create `src/acceptance/promotion-candidate-source.ts`:

```ts
import type { TerminalVerdictLog } from './terminal-verdict-log.js';
import { aggregateTerminalBySkill } from './terminal-verdict-log.js';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import type { PromotionCandidate, PromotionCandidateSource } from './promotion-coordinator.js';
import type { CodingCompletionGateRequest } from '../cli/coding-completion-gate.js';
import { memoryWarn } from '../memory/logger.js';

export interface TerminalCandidateSourceDeps {
  terminalVerdictLog: TerminalVerdictLog;
  /** 统计置信度门槛(D6 ①)。默认 minProofCount=10。 */
  minProofCount?: number;
}

/**
 * 从终局硬信号统计触发升层候选(T3.4 closure)。
 *
 * 读 terminal-verdict log,按 skill 聚合任务级终态(pass/fail)。某 skill 的
 * 终态 pass 数 ≥ minProofCount → 产一个候选。这是**系统统计触发**(非模型
 * 自报),统计源是 Plan.terminalAccept 产物级硬信号,不是验证器 contractSkill
 * pass(D5 可信根边界:验证器不得用自报成败作为升层依据)。
 *
 * 候选 id 稳定(term_${skill}),同证据窗口重评产生同 id(幂等,不刷屏)。
 *
 * 无终态信号(无 plan/terminalAccept 历史)→ 返 [],安全 no-op。
 */
export function createTerminalCandidateSource(
  deps: TerminalCandidateSourceDeps
): PromotionCandidateSource<CodingCompletionGateRequest> {
  const minProofCount = deps.minProofCount ?? 10;
  return async (_completion: CodingCompletionGateRequest) => {
    let entries;
    try {
      entries = await deps.terminalVerdictLog.readAll();
    } catch (err) {
      memoryWarn('promotion candidate source read failed:', err);
      return [];
    }
    const statsBySkill = aggregateTerminalBySkill(entries);
    const candidates: PromotionCandidate[] = [];
    for (const stats of statsBySkill.values()) {
      if (stats.proofCount < minProofCount) continue;
      candidates.push({
        id: `term_${stats.skill}`,
        targetSkill: stats.skill,
        provenance: {
          layer: 'L2',
          kind: 'explicit-proposal',
          source: 'terminal-hard-signal',
          proposalRef: `terminal://${stats.skill}?proof=${stats.proofCount}&rate=${stats.successRate.toFixed(2)}`,
        },
      });
    }
    return candidates;
  };
}

/** 给 statsSource 用的:从 terminal log 取某 skill 的统计(terminal-only)。 */
export function createTerminalStatsSource(
  deps: TerminalCandidateSourceDeps
): (candidate: PromotionCandidate) => Promise<ObservationStats | undefined> {
  return async (candidate) => {
    let entries;
    try {
      entries = await deps.terminalVerdictLog.readAll();
    } catch (err) {
      memoryWarn('promotion stats source read failed:', err);
      return undefined;
    }
    const statsBySkill = aggregateTerminalBySkill(entries);
    return statsBySkill.get(candidate.targetSkill);
  };
}
```

- [ ] **Step 4: Run the test green**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-candidate-source.spec.mjs
```

Expected: `✅ promotion-candidate-source ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/moss-agent/src/acceptance/promotion-candidate-source.ts packages/moss-agent/test/promotion-candidate-source.spec.mjs
git commit -m "feat(acceptance): terminal-signal promotion candidate source + stats source"
```

---

### Task 3: Promotion Opinion Sink (Persist Decision as Observation)

**Files:**

- Create: `packages/moss-agent/src/acceptance/promotion-opinion-sink.ts`
- Create: `packages/moss-agent/test/promotion-opinion-sink.spec.mjs`

**Interfaces:**

- Consumes: `MemoryManager.add(content, source?, filePath?, options?)` (returns `Promise<string>`), `PromotionDecisionRecord` (from `promotion-coordinator.ts`).
- Produces: `createOpinionSink(deps): PromotionDecisionSink` where `PromotionDecisionSink = (record: PromotionDecisionRecord) => void | Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `test/promotion-opinion-sink.spec.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from '../dist/core/index.js';
import { createOpinionSink } from '../dist/acceptance/promotion-opinion-sink.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sink-'));
const mm = new MemoryManager({ baseDir: tmp });
const sink = createOpinionSink({ memoryManager: mm });

const candidate = {
  id: 'term_rdk-device',
  targetSkill: 'rdk-device',
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'terminal-hard-signal',
    proposalRef: 'terminal://rdk-device?proof=12&rate=0.92',
  },
};
// statistics passed but cross-signal failed (production outcome)
const decision = {
  promotable: false,
  reason: 'statistics pass, cross-signal not confirmed',
  statisticalPassed: true,
  crossSignalPassed: false,
};

await sink({ candidate, decision });

const all = await mm.getAll();
assert.equal(all.length, 1, 'one Opinion written');
const entry = all[0];
assert.equal(entry.trust, 'observation', 'trust=observation (evolvable, not world)');
assert.ok(entry.content.includes('rdk-device'));
assert.ok(entry.content.includes('statisticalPassed=true'));
assert.ok(entry.content.includes('crossSignalPassed=false'));
assert.ok(entry.content.includes('non-promotable'));

// a promotable decision also lands (path not dead) but still observation trust
await sink({
  candidate,
  decision: {
    promotable: true,
    reason: 'both gates pass',
    statisticalPassed: true,
    crossSignalPassed: true,
  },
});
const all2 = await mm.getAll();
assert.ok(all2.length >= 2);
assert.ok(all2.some((e) => e.trust === 'observation' && e.content.includes('promotable')));

await fs.rm(tmp, { recursive: true, force: true });
console.log(
  '✅ promotion-opinion-sink: one Opinion per decision, trust=observation, records decision detail'
);
```

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-opinion-sink.spec.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `dist/acceptance/promotion-opinion-sink.js`.

- [ ] **Step 3: Implement the sink**

Create `src/acceptance/promotion-opinion-sink.ts`:

```ts
import type { MemoryManager } from '../core/memory/memory-manager.js';
import type { PromotionDecisionRecord, PromotionDecisionSink } from './promotion-coordinator.js';
import { memoryWarn } from '../memory/logger.js';

export interface OpinionSinkDeps {
  memoryManager: MemoryManager;
  scope?: 'workspace' | 'device';
  scopeRef?: string;
}

/**
 * 把升层决策沉淀为一条 trust=observation 的 Opinion 记忆(T3.4 closure)。
 *
 * 关键(D6):升层不改变可信根归属。 Opinion 是 trust=observation(可演化层),
 * 不是 trust=world(可信根)。即便决策 promotable=true,也只是"统计+跨信号双门槛
 * 都过"的归纳结论,测量有效性主张仍永久归属 World 层 —— 不会被这条 Opinion
 * 赋予"自证可信"地位。本切片不动任何 ACCEPTANCE.json(契约物化留下一阶段)。
 *
 * 失败只 warn 不抛(副作用式,不影响 completion)。
 */
export function createOpinionSink(deps: OpinionSinkDeps): PromotionDecisionSink {
  return async (record: PromotionDecisionRecord) => {
    const { candidate, decision } = record;
    const content = [
      `Promotion Opinion: skill=${candidate.targetSkill}`,
      `candidate=${candidate.id}`,
      `provenance=${candidate.provenance.source}`,
      `promotable=${decision.promotable}`,
      `statisticalPassed=${decision.statisticalPassed}`,
      `crossSignalPassed=${decision.crossSignalPassed}`,
      `reason=${decision.reason}`,
    ].join(' | ');
    try {
      await deps.memoryManager.add(content, 'memory', undefined, {
        trust: 'observation',
        scope: deps.scope,
        scopeRef: deps.scopeRef,
        topic: `promotion:${candidate.targetSkill}`,
      });
    } catch (err) {
      memoryWarn('promotion opinion sink write failed:', err);
    }
  };
}
```

- [ ] **Step 4: Run the test green**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-opinion-sink.spec.mjs
```

Expected: `✅ promotion-opinion-sink ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/moss-agent/src/acceptance/promotion-opinion-sink.ts packages/moss-agent/test/promotion-opinion-sink.spec.mjs
git commit -m "feat(acceptance): promotion opinion sink — persist decision as trust=observation"
```

---

### Task 4: Write Terminal Verdict on Completion (Feed the Statistic Source)

**Files:**

- Modify: `packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts`
- Modify: `packages/moss-agent/src/cli-main.ts` (construct `terminalVerdictLog`, pass to gate)
- Test: extend `test/terminal-arbitration-gate.spec.mjs`

**Interfaces:**

- Consumes: `TerminalVerdictLog` (from Task 1), the existing `arbitrateTaskTerminal` terminal verdict, the current plan's skills (from `plan.steps[].expectedAccept` — a `PlanStep` may list the contract skill(s) it references).
- Produces: a side-effect write of one `TerminalVerdictEntry` per skill referenced by the plan's steps, for each audited completion. The task-level terminal verdict is tagged per-skill this way so per-skill terminal statistics stay sound. If no skill can be derived (no `expectedAccept` on any step), write one entry with skill `'unknown'` so the audit logic is unchanged.

**Note on the Plan shape (verified against code):** `Plan` has `steps: PlanStep[]`; `PlanStep` has `expectedAccept?: string[]` (contract skill names it references). `Plan` does NOT have an `expectedSkill` field — derive skills from `plan.steps[].expectedAccept` only.

- [ ] **Step 1: Write the failing test (extend the existing spec)**

Append to `test/terminal-arbitration-gate.spec.mjs`, before the final `fs.rm`:

```js
// ─── 7. T3.4 closure: terminal verdict recorded to log for promotion stats ─
{
  const { TerminalVerdictLog } = await import('../dist/acceptance/terminal-verdict-log.js');
  const tvLog = new TerminalVerdictLog({ baseDir: tmp });
  const productFile = path.join(tmp, 'exists2.bin');
  await fs.writeFile(productFile, 'ok');
  const plan = {
    id: 'ptv',
    goal: 'g',
    status: 'executing',
    version: 1,
    // steps reference contract skills via expectedAccept (the real Plan shape)
    steps: [
      { step: 1, description: 'deploy', status: 'completed', expectedAccept: ['rdk-device'] },
    ],
    createdAt: '',
    updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log,
    planProvider: { current: plan },
    deviceExecutor: { current: null },
    workspaceDir: tmp,
    terminalVerdictLog: tvLog,
  });
  await wrapped({
    sessionKey: 'stv',
    runId: 'r',
    turn: 1,
    response: '',
    messages: [],
    totalToolCalls: 1,
    toolCallsByName: {},
  });
  const recorded = await tvLog.readAll();
  assert.equal(recorded.length, 1, 'terminal verdict recorded once per referenced skill');
  assert.equal(recorded[0].skill, 'rdk-device');
  assert.equal(recorded[0].verdict, 'pass');
}
console.log('✓ T3.4 closure: terminal verdict recorded to log (promotion statistic feed)');
```

Update the final success line to `(7/7)`.

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: FAIL — `terminalVerdictLog` not in the deps / nothing written.

- [ ] **Step 3: Extend the gate to write the verdict**

In `src/core/tools/terminal-arbitration-gate.ts`, add `terminalVerdictLog?` to `TerminalArbitrationGateDeps`. After `const { terminal, arbitration } = await arbitrateTaskTerminal(...)` (still inside the `try` and the `plan.status === 'executing'` block), collect the skills referenced by the plan's steps and write one entry per skill:

```ts
if (deps.terminalVerdictLog) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const skills = new Set<string>();
  for (const st of steps) {
    for (const sk of (st as { expectedAccept?: string[] }).expectedAccept ?? []) {
      if (typeof sk === 'string' && sk) skills.add(sk);
    }
  }
  const skillList = skills.size > 0 ? [...skills] : ['unknown'];
  for (const skill of skillList) {
    try {
      await deps.terminalVerdictLog.append({
        id: `${plan.id}:${req.sessionKey}:${skill}`,
        skill,
        verdict: terminal.verdict,
        reason: terminal.reason,
        sessionKey: req.sessionKey,
        timestamp: '2026-07-29T00:00:00.000Z',
      });
    } catch (err) {
      memoryWarn('terminal verdict log write failed:', err);
    }
  }
}
```

The gate already imports `memoryWarn` from `'../../memory/logger.js'`. The `deps.terminalVerdictLog` field is optional so existing callers without it are unaffected.

- [ ] **Step 4: Run the test green**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: `✅ terminal-arbitration-gate P0 接线 全部通过(7/7)`.

- [ ] **Step 5: Commit**

```bash
git add packages/moss-agent/src/core/tools/terminal-arbitration-gate.ts packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
git commit -m "feat(acceptance): record terminal verdict to log for promotion statistics"
```

---

### Task 5: Wire Real Candidate/Stats/Sink into CLI Runtime

**Files:**

- Modify: `packages/moss-agent/src/cli-main.ts` (the `promotionRefs` block ~line 648 and the init block ~line 852)
- Test: extend `test/promotion-coordinator.spec.mjs` with an end-to-end "real closure" test

**Interfaces:**

- Consumes: `createTerminalCandidateSource`, `createTerminalStatsSource` (Task 2), `createOpinionSink` (Task 3), `TerminalVerdictLog` (Task 1), existing `promotionCoordinator` + `promotionRefs`.
- Produces: production candidate/stats/sink that flow real candidates; `crossSignalVerifier` stays `() => false`.

- [ ] **Step 1: Write the failing end-to-end test (extend promotion-coordinator.spec.mjs)**

Append a test that wires real deps and proves a statistics-passing candidate still gets `non-promotable` (production D6 guarantee) AND the Opinion lands:

```js
// ─── T3.4 closure: real candidate flows, statistics-pass still non-promotable (D6), Opinion lands ─
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { createTerminalCandidateSource, createTerminalStatsSource } from '../dist/acceptance/promotion-candidate-source.js';
import { createOpinionSink } from '../dist/acceptance/promotion-opinion-sink.js';
import { MemoryManager } from '../dist/core/index.js';

{
  const tmpClosure = await import('node:fs/promises').then(fs => fs.mkdtemp(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'moss-closure-')));
  const tvLog = new TerminalVerdictLog({ baseDir: tmpClosure });
  for (let i = 0; i < 12; i++) {
    await tvLog.append({ id: String(i), skill: 'rdk-device', verdict: 'pass', reason: 'ok', sessionKey: 's', timestamp: 't' });
  }
  const mm = new MemoryManager(tmpClosure);
  const records = [];
  const coordinator = new PromotionCoordinator({
    candidateSource: createTerminalCandidateSource({ terminalVerdictLog: tvLog, minProofCount: 10 }),
    statsSource: createTerminalStatsSource({ terminalVerdictLog: tvLog }),
    crossSignalVerifier: () => false, // production: layer-3 not wired -> always reject
    decisionSink: async (r) => { records.push(r); await createOpinionSink({ memoryManager: mm })(r); },
  });
  await coordinator.observeCompletion({ sessionKey: 's', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });

  assert.equal(records.length, 1, 'one candidate flowed through');
  assert.equal(records[0].candidate.targetSkill, 'rdk-device');
  assert.equal(records[0].decision.statisticalPassed, true, '12 passes -> statistics pass');
  assert.equal(records[0].decision.crossSignalPassed, false, 'production verifier rejects (D6: no cross-signal = no promotion)');
  assert.equal(records[0].decision.promotable, false, 'not promotable in production (loop runs, no auto-promotion)');

  const mems = await mm.getAll();
  assert.equal(mems.length, 1, 'one Opinion landed');
  assert.equal(mems[0].trust, 'observation');

  await import('node:fs/promises').then(fs => fs.rm(tmpClosure, { recursive: true, force: true }));
}
console.log('✓ T3.4 closure: real candidate flows, statistics-pass stays non-promotable (D6), Opinion lands');
```

- [ ] **Step 2: Run the red test**

```bash
npm run build -w @rdk-moss/agent && node packages/moss-agent/test/promotion-coordinator.spec.mjs
```

Expected: FAIL (the new test block runs but the assertion on records/Opinion fails because the imports/types aren't yet validated together — actually this test is self-contained and should pass once build succeeds; if it fails, it's a wiring bug in the helper modules, fix before proceeding).

- [ ] **Step 3: Wire into cli-main.ts**

In the `promotionRefs` init block (where it currently sets all four to empty), replace the empty production deps with real ones (keep `crossSignalVerifier = () => false`):

```ts
// T3.4 closure: wire real candidate/stats/sink. crossSignalVerifier STAYS () => false
// (layer-3 geometry not wired — D6: statistics-pass still non-promotable, loop runs
// without auto-promotion). Candidate source reads terminal hard-signal stats, NOT
// contractSkill aggregates (D5 trusted-root boundary).
const terminalVerdictLog = new TerminalVerdictLog({
  baseDir: workspacePathMigration.paths.memoryDir,
});
promotionRefs.candidateSource = createTerminalCandidateSource({ terminalVerdictLog });
promotionRefs.statsSource = createTerminalStatsSource({ terminalVerdictLog });
promotionRefs.crossSignalVerifier = () => false;
promotionRefs.decisionSink = createOpinionSink({ memoryManager: memoryManager });
```

Add the imports near the existing promotion imports:

```ts
import { TerminalVerdictLog } from './acceptance/terminal-verdict-log.js';
import {
  createTerminalCandidateSource,
  createTerminalStatsSource,
} from './acceptance/promotion-candidate-source.js';
import { createOpinionSink } from './acceptance/promotion-opinion-sink.js';
```

Also pass `terminalVerdictLog` into the `terminalArbitration` deps object in the `composeCliCompletionGate` call (so Task 4's write fires):

```ts
terminalArbitration: {
  get experienceLog() { ... },
  get planProvider() { ... },
  get deviceExecutor() { ... },
  get workspaceDir() { return workspace; },
  terminalVerdictLog,
} as any,
```

And construct `terminalVerdictLog` in the refs-declaration region (before the `MossAgent` construction, beside `terminalArbitrationRefs`), so both the gate and the promotion refs reference the same instance:

```ts
const terminalVerdictLog = new TerminalVerdictLog({
  baseDir: workspacePathMigration.paths.memoryDir,
});
```

(Then the init block assigns `promotionRefs.*` using this already-constructed instance.)

- [ ] **Step 4: Run regressions**

```bash
npm run build -w @rdk-moss/agent
node packages/moss-agent/test/promotion-coordinator.spec.mjs
node packages/moss-agent/test/promotion-candidate-source.spec.mjs
node packages/moss-agent/test/promotion-opinion-sink.spec.mjs
node packages/moss-agent/test/terminal-verdict-log.spec.mjs
node packages/moss-agent/test/cli-completion-gate-composition.spec.mjs
node packages/moss-agent/test/terminal-arbitration-gate.spec.mjs
```

Expected: every process exits 0.

- [ ] **Step 5: Verify no L1 shortcut + typecheck**

```bash
rg -n "aggregateBySkill|contractSkill|ObservationAggregator" packages/moss-agent/src/cli-main.ts packages/moss-agent/src/acceptance/promotion-candidate-source.ts packages/moss-agent/src/acceptance/promotion-opinion-sink.ts packages/moss-agent/src/acceptance/terminal-verdict-log.ts
```

Expected: no matches (the trusted-root boundary is honored — promotion wiring never touches L1 contractSkill aggregation).

```bash
npm run typecheck -w @rdk-moss/agent
```

Expected: no errors.

- [ ] **Step 6: Run full agent package test**

```bash
npm test -w @rdk-moss/agent
```

Expected: `[test] passed N file(s)`, exit 0. (Pre-existing `coding-completion-gate` EBUSY and `piped-stdin` flakies were already fixed this session; if either re-occurs, record it and prove the new/changed suites pass separately — do not misreport.)

- [ ] **Step 7: Commit**

```bash
git add packages/moss-agent/src/cli-main.ts packages/moss-agent/test/promotion-coordinator.spec.mjs
git commit -m "feat(acceptance): wire real T3.4 promotion closure into CLI runtime"
```

---

### Task 6: Documentation and Final Verification

**Files:**

- Modify: `docs/self-evolution-loop.md` (T3.4 roadmap entry ~line 479)

- [ ] **Step 1: Update the T3.4 roadmap entry**

State that the promotion loop now runs: real candidates flow from terminal hard-signal statistics, `evaluatePromotion` produces real decisions, and decisions land as `trust=observation` Opinions. Production `crossSignalVerifier` stays `() => false` (layer-3 geometry not wired), so statistics-passing candidates are still non-promotable — the loop runs without auto-promotion (D6). Contract materialization remains follow-up.

- [ ] **Step 2: Final full verification**

```bash
npm run typecheck -w @rdk-moss/agent
npm run lint
npm test -w @rdk-moss/agent
npm test -w @rdk-moss/core
```

Expected: typecheck 0 errors, lint clean, all workspace tests pass.

- [ ] **Step 3: Commit**

```bash
git add docs/self-evolution-loop.md
git commit -m "docs(acceptance): mark T3.4 promotion closure running (Opinion sink, no auto-promotion)"
```
