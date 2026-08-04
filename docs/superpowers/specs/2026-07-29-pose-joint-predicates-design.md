# pose_error_within + joint_at Predicates Design

Date: 2026-07-29
Status: Approved (standing authorization)

## Goal

Implement the two geometric predicates that complete the D7 cross-signal mechanism: `pose_error_within` (pose error from a chosen source — camera or encoder) and `joint_at` (joint angle reaches target). These follow the `force_below` pattern (readonly device command + regex parse + threshold compare), staying D5-safe (no device / unparseable → `unknown`).

`pose_error_within` is special: its `source` param is `'camera'|'encoder'` — the two independent physical signals D7 compares. Measuring the same physical quantity from two independent sources and comparing them is exactly the cross-signal bias detection. So implementing `pose_error_within` for both sources provides both the L1 predicate AND the `biasReference` source — the full D7 mechanism in one predicate.

## Boundary

- Implements `pose_error_within` and `joint_at`. `video_fps_above` remains `unknown` (separate slice).
- Each needs readonly device read: `readCommand` (readonly command printing the value) + `valueRegex` (regex with capture group for the number) in `params` — same additive pattern as `force_below`. Without them → `unknown`.
- `pose_error_within` compares the parsed value to `threshold_mm` (below → pass, at/above → fail). `joint_at` compares to `target` within `tolerance` (|value - target| <= tolerance → pass).
- No device executor → `unknown`. Bad parse → `unknown`. This is D5: measure when you can, else unknown.
- Does NOT wire physical read into `biasReference` in production yet (needs board-specific readCommands + a live device). That wiring is follow-up; the predicates are the building blocks.

## Architecture

Extend `evaluatePredicate`:

- `pose_error_within`: parse `threshold_mm`, `source` (accept any — source is informational here, the cross-signal comparison is done by the bias verifier using two separate `source` reads), `readCommand`, `valueRegex`. Run readonly, parse number, compare to `threshold_mm`. Same shape as `force_below`.
- `joint_at`: parse `target` (number), `tolerance` (number, default 0), `readCommand`, `valueRegex`. Run readonly, parse number, |value - target| <= tolerance → pass, else fail.

## Failure Semantics (D5)

- No readCommand/valueRegex/target → `unknown` (reasonCode distinguishes each).
- No device / device null → `unknown`.
- Regex no match / non-numeric → `unknown`.
- Only a parsed value compared to threshold → pass/fail.

## Testing

TDD via `predicate-evaluator.spec.mjs`:
- `pose_error_within`: pass when error 3 < threshold_mm 10; fail when 12 >= 10; unknown when no readCommand / no device / unparseable.
- `joint_at`: pass when value 90 within tolerance 2 of target 90; fail when 95 vs target 90 tol 2; unknown cases.
- Update the "geometric predicates unknown" loop to remove `pose_error_within` and `joint_at` (now implemented), keep `video_fps_above`.

## Follow-up

- Wire `biasReference` to read `pose_error_within` with `source:'encoder'` while the candidate measured `source:'camera'` (or vice versa) — needs board-specific readCommands and a live device. This is where true cross-signal confirmation runs end-to-end on hardware.
- `video_fps_above` predicate (multimedia pipeline FPS).
- Contract materialization once a candidate reaches promotable.
