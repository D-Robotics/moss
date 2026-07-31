# T2.2 Observation Aggregator Runtime Wiring Design

Date: 2026-07-30
Status: Approved (standing authorization)

## Goal

Wire the already-implemented `ObservationAggregator` into the runtime loop. T2.2 is marked `[x]` in the roadmap but the doc itself notes "已实现待接线" (implemented, awaiting wiring). Today `new ObservationAggregator` appears nowhere except its definition — the aggregator is pure logic with no runtime caller, the same "implemented but not wired" gap T3.4/checkDrift had. This slice closes it: after a successful completion, fire-and-forget `aggregator.aggregate()` so Experience rows get aggregated into trust=observation memory entries.

This completes the self-evolution memory chain's first hop at runtime: Experience (per-tool verdicts) → Observation (per-skill successRate/proofCount) actually runs, not just in tests.

## Boundary

- Construct `ObservationAggregator({ experienceLog, memoryManager })` in `cli-main.ts` init block (both deps already available there).
- Trigger `aggregate()` on successful completion, fire-and-forget (async, never blocks, never throws into completion — aggregator already warns-only on failure).
- The simplest honest wiring: extend the promotion observation wrapper to also call the aggregator, since both run "after successful completion" and the aggregator is the memory-chain prerequisite for promotion statistics context. Alternatively a standalone observer. Keep them composed cleanly.
- No new memory-manager APIs (the "按 trust 删除" limitation noted in roadmap stays — re-aggregation creating new entries is the known accepted behavior).

## Architecture

In `cli-main.ts`, construct an `observationAggregator` beside `terminalVerdictLog`/`promotionRefs`. Wire a completion observer that calls `observationAggregator.aggregate()` after the composed gate returns ok. Reuse `composeCliCompletionGate`'s `promotionObserver` seam by composing the aggregator call into the promotion observer (or as a sibling). Fire-and-forget; errors are warn-only.

## Failure Semantics (D5/D1)

- Aggregator failure → warn only, never affects completion (existing aggregator behavior).
- No experience rows → aggregates nothing (no-op).
- Re-aggregation after stats change → new observation entries (known limitation, accepted).
- Async, non-blocking: completion is not awaited on aggregation.

## Testing

TDD via `observation-aggregator.spec.mjs` (extend) + integration:
- Existing aggregator spec still passes (additive).
- New: a wiring test confirming that after a successful completion the aggregator runs and produces an observation entry. (Unit-level: confirm the observer calls aggregate.)
- Regression: promotion-coordinator, cli-composition specs unchanged.

## Follow-up

- MemoryManager "delete by trust" / "update by key" API to make re-aggregation overwrite cleanly (roadmap-noted limitation).
- Tie aggregator output to promotion stats (currently promotion reads terminal-verdict log, not observation entries — these are separate statistic sources by design: observation = contractSkill L1 stats, promotion = terminal hard-signal stats; do NOT merge, that's the D5 boundary).
