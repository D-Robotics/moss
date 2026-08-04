# Drift Calibration Runtime Wiring Design

Date: 2026-07-30
Status: Approved (standing authorization)

## Goal

Wire the already-implemented `checkDrift` pure logic into the runtime loop so it actually runs. Currently `checkDrift` exists + is unit-tested but has **no caller** — the same "implemented but not wired" gap T3.4 had before its closure. This slice closes that gap: during terminal arbitration, for each suspect skill, run `checkDrift` (single-step pass rate from experiences vs terminal success rate from the terminal-verdict log), and surface drift in the audit-failure correction so the user knows a contract's calibration is drifting.

This is the "统计级漂移校准" item T3.3's roadmap marks `[待]` — but it's pure logic already implemented; what's missing is the runtime call.

## Boundary

- Extends `arbitrateTaskTerminal` to optionally take a `terminalVerdictLog` + `minDriftSamples` (default 10).
- After `auditTerminal`, for each suspect skill with enough terminal history (proofCount >= minDriftSamples), runs `checkDrift` using `singleStepPassRate` (from experiences) and `terminalSuccessRate` (from the terminal-verdict log aggregation).
- Cold-start guard: fewer than `minDriftSamples` terminal samples → skip drift (avoid false drift on insufficient data). This matches promotion's `minProofCount` discipline.
- Adds `driftChecks: DriftCheckResult[]` to the arbitration result. The gate's audit-failure correction mentions drift when detected.
- Drift is informational/observational: it never blocks completion by itself (auditFailed already decides blocking). It surfaces "this contract's single-step pass rate diverges from terminal success — recalibrate."
- No device/hardware dependency.

## Architecture

`arbitrateTaskTerminal` gains optional `terminalVerdictLog` + `minDriftSamples` in its input. After computing `arbitration`, for each `arbitration.suspectSkills` (or all skills in experiences when there are suspects), look up terminal stats via `aggregateTerminalBySkill(await log.readAll())`; if proofCount >= minDriftSamples, run `checkDrift({ singleStepPassRate, terminalSuccessRate, driftThreshold })`. Collect results into `arbitration.driftChecks` (additive; empty when no log / insufficient samples / no suspects).

Gate (`terminal-arbitration-gate.ts`): pass `deps.terminalVerdictLog` into the `arbitrateTaskTerminal` call (already in deps from T3.4 closure wiring). When `auditFailed` and any `driftChecks` detected, append drift context to the correction.

## Failure Semantics (D5)

- No terminal log → no drift checks (no-op; existing behavior).
- Fewer than minDriftSamples → no drift check for that skill (cold-start safe).
- Suspect skill not in terminal log → skipped.
- Drift never blocks completion; auditFailed remains the only blocking signal.

## Testing

TDD via `terminal-arbitrator.spec.mjs` (extend) + an integration check:
- `arbitrateTaskTerminal` with a terminalVerdictLog having >=10 samples where single-step pass rate (1.0) diverges from terminal success rate (0.3) → `driftChecks` non-empty, `driftDetected=true`.
- Fewer than minDriftSamples → `driftChecks` empty (cold-start guard).
- No terminalVerdictLog → `driftChecks` empty.
- Existing auditTerminal behavior unchanged (regression).

## Follow-up

- Multi-hop graph drift (already separate).
- Contract recalibration action (currently drift is surfaced; auto-recalibration is a later slice).
