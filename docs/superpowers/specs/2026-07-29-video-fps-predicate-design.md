# video_fps_above Predicate Design

Date: 2026-07-29
Status: Approved (standing authorization)

## Goal

Implement the last geometric predicate — `video_fps_above` (video stream frame rate exceeds threshold). Follows the `force_below`/`pose_error_within` pattern (readonly device command + regex parse + threshold compare). Completes the geometric-predicate set so no `AcceptPredicateName` returns `geometric_predicate_not_implemented`.

## Boundary

- `video_fps_above` params: `threshold_fps` (number), `readCommand` (readonly command printing FPS), `valueRegex` (regex with capture group for the FPS number).
- D5-safe: no `readCommand`/no device/device null/unparseable → `unknown`. Parsed FPS ≥ `threshold_fps` → pass (medium); below → fail (medium).
- No contract currently uses it; it's a building block for multimedia pipeline verification (rdk-multimedia contract could later reference it).

## Testing

TDD via `predicate-evaluator.spec.mjs`:
- pass when FPS 30 ≥ threshold 15; fail when 10 < 15.
- unknown when no readCommand / no device / unparseable.

## Follow-up

- Add to rdk-multimedia contract as a postcondition when real-board FPS read commands are known.
- Contract materialization; real-board readCommand tuning.
