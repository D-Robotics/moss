# Cross-Signal Verifier (D6 ②) — Bias-Detection Slice Design

Date: 2026-07-29
Status: Approved (standing "decisions all yours" authorization)

## Goal

Make the D6 second gate (measurement-effectiveness / cross-signal confirmation) a real, injectable function rather than a placeholder `() => false` — so the self-evolution promotion path's cross-signal gate is genuinely exercisable. The first slice proves the path with a **bias-detection** verifier that the U5 counterexample already demonstrates: it detects a systematic measurement bias across independent samples, returning `false` (refuse promotion) when the candidate's measurement is systematically skewed.

This does NOT yet wire a real physical independent signal (encoder-vs-vision). It makes the verifier injectable and proves the gate works end-to-end with a real (not stub) verifier function. Wiring a physical independent-signal read is a follow-up slice (needs board-specific read commands, like force_below's readCommand).

## Boundary

- Implements an **injectable** `crossSignalVerifier` factory that produces a real function (not `() => false`) from a terminal-verdict log + an optional bias-spec.
- The first verifier is **bias-detection**: given a candidate's recent measurement samples (from the terminal-verdict log's `reason`/evidence), it checks whether the measurement is systematically biased relative to an independent reference. If biased → `false` (D6: correlation ≠ correctness, refuse).
- Does NOT wire encoder-vs-vision physics. The independent-reference for bias detection is supplied injectably (tests inject a known-good reference; production supplies a conservative `() => false` fallback until physical reads exist).
- Production default stays conservative: no independent reference configured → `() => false`. The slice's value is that a _real_ verifier can now be injected and exercised (closing the "crossSignalVerifier is a dead stub" gap), and the U5 logic runs through the real promotion path.

## Architecture

Add `src/acceptance/cross-signal-bias-verifier.ts` exporting:

- `createBiasDetectionVerifier(deps): CandidateCrossSignalVerifier`
  - `deps.biasReference?: (candidate) => Promise<number[] | null>` — returns the independent signal's measurement array for the candidate (e.g. encoder-computed pose errors). `null` = no independent reference available → return `false` (conservative, no confirmation).
  - `deps.measurementExtractor?: (candidate) => Promise<number[] | null>` — returns the candidate's own measurement array (e.g. visual pose errors from terminal-verdict log evidence). `null` = no samples → `false`.
  - `deps.biasTolerance?: number` — max acceptable mean absolute deviation between the two signal arrays (default 0, meaning any consistent nonzero bias fails; U5 uses a small epsilon).
  - The verifier: if either array missing/null/different-length → `false`. Compute per-sample deltas; if the deltas are consistent (stddev below a small epsilon) AND the mean delta exceeds `biasTolerance` → systematic bias → `false`. Else → `true` (measurement agrees with independent signal → confirmed).

This mirrors the U5 counterexample's exact logic (`visualErrors`, `encoderErrors`, `systematicBias` check), generalized into an injectable factory so the same logic runs through the production `evaluatePromotion` path, not just a test.

## Wiring

In `cli-main.ts`, `promotionRefs.crossSignalVerifier` changes from `() => false` to a `createBiasDetectionVerifier` with **conservative production deps**:

- `biasReference: () => null` (no physical independent read yet → always returns null → verifier returns `false`). This preserves the current conservative behavior exactly while making the verifier real and injectable.
- Tests inject real `biasReference`/`measurementExtractor` to prove the gate exercises.

So production behavior is unchanged (candidates still non-promotable), but the cross-signal gate is now a real function with an injection seam — the "dead stub" is replaced with an honest "no independent reference configured" conservative verifier.

## Failure Semantics (D5/D6)

- No independent reference (production now) → `false` (refuse; measurement-effectiveness unconfirmed). Same outcome as before, now honest.
- Samples unavailable / mismatched length → `false` (can't confirm).
- Consistent nonzero bias detected → `false` (systematic measurement skew; D6 refuse — this is the U5 case).
- Signals agree (deltas within tolerance) → `true` (measurement-effectiveness confirmed → candidate could be promotable if statistics also pass).

## Testing

TDD via `cross-signal-bias-verifier.spec.mjs`:

- No biasReference → `false` (production default).
- biasReference returns null → `false`.
- Measurements with consistent 8-unit bias, encoder reference at 0 → `false` (U5 case reproduced through the real verifier).
- Measurements matching reference (no bias) → `true`.
- Mismatched sample lengths → `false`.
- Inject into `evaluatePromotion`: biased candidate → non-promotable (crossSignalPassed=false); unbiased → promotable (crossSignalPassed=true) — proves the gate exercises end-to-end through the real promotion path.
- Existing U5 spec still passes (it uses its own inline verifier; the new factory is additive, not replacing).

## Follow-up

- Wire a real physical independent-signal reader for `biasReference` (e.g. joint-encoder pose computation confirming a camera pose) — needs board-specific readonly read commands. This is where `joint_at`/`pose_error_within` predicates finally get consumed.
- Contract materialization once a candidate reaches promotable.
