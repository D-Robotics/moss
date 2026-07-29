# T3.4 Promotion Closure — Opinion Sink (Real Loop)

Date: 2026-07-29
Status: Approved (architecture section user-confirmed; remaining sections authored under standing "decisions all yours" authorization)

## Goal

Take the T3.4 runtime skeleton (which already wires `PromotionCoordinator` + `composeCliCompletionGate` into the CLI with production dependencies deliberately empty) and make the loop **actually run**: a real promotion candidate flows through the four dependency seams, `evaluatePromotion` produces a real `PromotionDecision`, and the decision lands as a persisted `trust=observation` Opinion. This closes the self-evolution loop without granting auto-promotion.

The closure is honest: in production the cross-signal verifier stays conservative, so a candidate whose statistics pass still receives a `non-promotable` decision. The loop is "running" because a real candidate and real decision now flow through and persist — not because anything gets promoted. Auto-promotion remains blocked until layer-3 geometry predicates are wired (separate work).

## Boundary (what this slice does NOT do)

- Does NOT set `crossSignalVerifier` to anything that can return `true` in production. Layer-3 geometry predicates (`pose_error_within`, `joint_at`) still return `unknown` and are not wired. A passing-statistics candidate therefore always fails the cross-signal gate. This is the D6 guarantee: correlation ≠ correctness, no cross-signal confirmation → no promotion.
- Does NOT mutate any `ACCEPTANCE.json`, `ContractRegistry`, or L1 contract. The sink writes a single Opinion memory entry; contract materialization is explicitly out of scope (deferred to a later slice).
- Does NOT derive candidates from L1 `contractSkill` aggregates. The candidate source reads **terminal hard-signal statistics** (task-level pass/fail from `Plan.terminalAccept` product predicates), not the per-tool verdicts the contract verifier itself produced. This is the trusted-root boundary: the verifier must not judge its own success as a basis for promotion.

## Architecture

The four `PromotionCoordinatorDeps` seams, currently empty/conservative in `cli-main.ts`, are populated as follows:

| Seam | Current (empty) | This slice (real) | Data source |
|---|---|---|---|
| `candidateSource` | `() => []` | Terminal hard-signal statistics trigger: a skill whose tasks have passed `terminalAccept` enough times crosses `minProofCount` → emits one candidate | `Plan.terminalAccept` product-level verdicts, aggregated per skill |
| `statsSource` | `() => undefined` | The candidate's `ObservationStats` (successRate/proofCount) from **terminal-only** aggregation | A terminal-signal aggregator (NOT `aggregateBySkill`'s contractSkill path) |
| `crossSignalVerifier` | `() => false` | Stays `() => false` (layer-3 geometry not wired) | None — conservative reject |
| `decisionSink` | `() => {}` | Persists the candidate + `PromotionDecision` as a single `trust=observation` Opinion | `MemoryManager` |

## Candidate Identity

A `PromotionCandidate` (existing type) carries `id`, `targetSkill`, and provenance `{ layer: 'L2', kind: 'explicit-proposal', source, proposalRef }`. This slice:

- `targetSkill`: the skill whose terminal tasks accumulated enough passes.
- `id`: stable, derived from the skill + the terminal-signal epoch (so re-evaluation across the same evidence window is idempotent, not a flood of new candidates). Form: `term_${skill}` mirroring the existing observation-entry id convention.
- `provenance.source`: `'terminal-hard-signal'` (distinguishes from any future explicit human proposal).
- `provenance.proposalRef`: a digest of the evidence window (which experiences / terminal verdicts back the candidate), so the Opinion can cite what it was based on.

The coordinator already requires candidates to be explicit L2 with a stable id and does not infer identity from `stats.skill` — this slice honors that by constructing the candidate from terminal statistics and stamping the id itself.

## Data Flow

1. A CLI turn completes successfully. The promotion wrapper (`wrapWithPromotionObservation`) calls `promotionCoordinator.observeCompletion(request)` after the terminal+coding gates accept.
2. `candidateSource(request)` reads the terminal-signal statistics for skills touched by this session's plan(s). For each skill whose terminal pass count crosses `minProofCount` (default 10), it emits one `PromotionCandidate` with the id/provenance above. Skills below threshold emit nothing.
3. For each candidate, `statsSource(candidate)` returns the terminal-only `ObservationStats` (successRate, proofCount) for that skill. If no statistics exist, the candidate is skipped — no fabricated decision (existing coordinator behavior).
4. `evaluatePromotion(stats, verifierForCandidate, thresholds)` runs the D6 dual gate. In production the verifier is `() => false`, so:
   - statistics fail → `non-promotable`, `statisticalPassed=false`.
   - statistics pass but cross-signal fails → `non-promotable`, `crossSignalPassed=false` (the expected production outcome).
   - statistics pass AND cross-signal passes → `promotable` (cannot happen in production this slice; reachable only in tests injecting a true verifier).
5. `decisionSink({ candidate, decision })` writes one `trust=observation` Opinion via `MemoryManager`. The Opinion content records the skill, the statistics, and the decision reason, so a later reader can see "skill X's terminal evidence crossed the statistical bar but cross-signal confirmation was absent."
6. The wrapper returns the original successful completion result unchanged. Promotion never rejects or alters completion.

## Failure Semantics

The coordinator already isolates each seam's failures (logs a warning, continues, never affects completion). This slice preserves that:

- `candidateSource` throws → coordinator logs, returns (no candidates, no decision). Completion unaffected.
- `statsSource` throws or returns undefined → candidate skipped. Completion unaffected.
- `evaluatePromotion` throws → candidate skipped. Completion unaffected.
- `decisionSink` throws → coordinator logs, continues. Completion unaffected. A sink failure must not consume a completion retry.
- Terminal signal unavailable (no plan, no `terminalAccept`) → `candidateSource` emits no candidates. This is the common cold-start case and is a safe no-op, not an error.

## Testing

TDD, focused unit + integration:

- **Terminal-signal aggregator**: aggregates task-level terminal pass/fail/unknown per skill, NOT from contractSkill. Verify a skill with ≥minProofCount terminal passes produces stats; a skill with only contractSkill evidence produces no stats (proves the no-L1-shortcut boundary).
- **Candidate source**: emits a candidate only when terminal pass count crosses threshold; idempotent across re-evaluation of the same window (same id); emits nothing for skills below threshold or with no terminal signal.
- **Decision sink**: writes exactly one `trust=observation` Opinion per candidate; content includes skill + stats + decision; does not touch any contract file (assert no `ACCEPTANCE.json` write).
- **Production cross-signal stays conservative**: a candidate with passing statistics still gets `non-promotable` because the production verifier is `() => false` (D6: no auto-promotion). A test injecting a true verifier reaches `promotable` to prove the path isn't dead.
- **Integration**: a successful completion with terminal-hard-signal evidence flows candidate → stats → decision → one Opinion, and completion is returned unchanged.
- **No L1 shortcut**: `rg` confirms no `aggregateBySkill`/`contractSkill` reference in the new wiring (boundary documented, not violated).
- Existing promotion-coordinator, promotion-completion-gate, cli-completion-gate-composition, and typecheck suites remain green.

## Follow-up (explicitly deferred)

- Real cross-signal verification: wire layer-3 geometry predicates (`pose_error_within`, `joint_at`) so `crossSignalVerifier` can return `true`. Until then promotion is correctly blocked.
- Contract materialization: once a candidate reaches `promotable` (after real cross-signal), materialize an L1 contract change — this is where the stronger "strengthen existing contract" or "new contract" slices belong.
- Candidate-level aggregation refinement, independent attestation storage, review queue — the full L2 lifecycle beyond the running Opinion sink.
