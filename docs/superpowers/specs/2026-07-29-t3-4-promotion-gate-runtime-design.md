# T3.4 Promotion Gate Runtime Design

Date: 2026-07-29
Status: Approved by delegated user choice

## Goal

Wire the existing D6 dual-threshold promotion gate into runtime without claiming that an existing L1 skill statistic is an L2 promotion candidate. The first runtime slice must be honest, non-blocking, injectable, and testable. It must not mutate acceptance contracts automatically.

## Scope

This slice adds a promotion coordinator to the successful completion path. It evaluates only candidates supplied by an explicit candidate source, delegates statistical and independent-signal checks to existing promotion logic, and sends every resulting decision to an explicit sink.

No candidate means a safe no-op. Insufficient evidence or failed cross-signal verification produces a rejection decision but never rejects task completion. Coordinator errors are logged and do not affect the primary agent flow.

The following remain out of scope:

- Deriving L2 candidates from generic L2 Experience rows.
- Defining a persisted candidate schema or automatic candidate discovery.
- Treating existing `contractSkill` aggregates as L2 evidence.
- Treating an ordinary terminal pass as independent cross-signal confirmation.
- Automatically writing or changing L1 contracts.
- Human review queues and approval policy.

## Architecture

Add a host-agnostic `PromotionCoordinator` with four explicit dependencies:

1. `candidateSource`: returns zero or more typed promotion candidates for a completion.
2. `statsSource`: returns `ObservationStats` for a candidate identity.
3. `crossSignalVerifier`: validates measurement effectiveness using an independent signal.
4. `decisionSink`: records or exposes the candidate plus `PromotionDecision`.

A candidate has a stable ID, target skill, and enough provenance to distinguish an actual L2 proposal from an existing L1 contract statistic. The coordinator does not infer candidate identity from `ObservationStats.skill`.

A runtime wrapper composes the coordinator with the existing completion gate. The original gate remains authoritative. Promotion work runs only after the original gate returns `{ ok: true }`, so failed or correction-bound attempts cannot generate promotion decisions.

The wrapper is independent from terminal arbitration. CLI composition is:

```text
MossAgent internal validation
  -> terminal arbitration wrapper
    -> coding completion gate
  -> promotion observation after successful result
```

At the wrapper level this means promotion wraps the already terminal-wrapped CLI gate. T3.3 can still block completion, and T3.4 only observes a completion after all configured gates accept it.

## Data Flow

1. Completion request enters the promotion wrapper.
2. The wrapper awaits the original composed gate.
3. If the result is not successful, return it unchanged and do no promotion work.
4. Ask `candidateSource` for candidates associated with this completion context.
5. For each candidate, request typed statistics from `statsSource`.
6. If statistics are unavailable, emit no fabricated decision; the candidate remains unevaluated.
7. Call `evaluatePromotion(stats, verifierForCandidate, thresholds)`.
8. Send the candidate and decision to `decisionSink`.
9. Return the original successful gate result unchanged.

Candidate-specific verification adapts the current skill-based `CrossSignalVerifier` API while preserving candidate identity in the coordinator boundary. A later schema migration can make `evaluatePromotion` candidate-native without changing runtime composition.

## Failure Semantics

Promotion is observational, not a completion criterion:

- No candidates: no-op.
- No statistics: skip safely.
- Statistical gate fails: sink receives the conservative rejection decision.
- Cross-signal gate fails: sink receives the conservative rejection decision.
- Dependency throws: log one warning and return the original successful completion result.
- Decision sink throws: log and continue; do not retry through the completion loop.

This prevents normal cold-start evidence gaps or telemetry failures from consuming completion retries.

## CLI Wiring

Follow the late-bound dependency pattern already used by T3.3 in `cli-main.ts`. Construct stable refs before completion-gate creation, then populate concrete dependencies during CLI initialization.

The initial production candidate source is intentionally empty. This proves the runtime lifecycle and preserves honest semantics until the L2 candidate model exists. Tests inject candidates, statistics, verifiers, and sinks to exercise the full flow.

Do not route T3.4 through `aggregateBySkill()` in production in this slice: that function currently aggregates L1 `contractSkill` evidence and cannot identify an L2 proposal.

## Testing

Use test-driven development with focused unit and integration coverage:

- Successful original gate with no candidates is a no-op.
- Rejected original gate never queries candidates.
- Candidate with insufficient statistics produces a non-promotable decision without calling cross-signal verification.
- Candidate meeting statistical thresholds but failing cross-signal verification remains non-promotable.
- Candidate passing both gates reaches the sink as promotable.
- Candidate/stats/verifier/sink failures do not change the original successful result.
- CLI composition places promotion outside terminal arbitration, so a terminal audit rejection cannot trigger promotion.
- Existing promotion-gate, terminal-arbitration, completion-gate, and typecheck suites remain green.

## Follow-up

The next design slice defines the real L2 candidate lifecycle: candidate schema, generic L2 Experience provenance, candidate-level aggregation, independent attestation storage, review sink, and eventual contract materialization. That work must not reuse L1 `contractSkill` aggregates as a shortcut.
