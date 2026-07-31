# Pose Cross-Signal Wiring (D7 end-to-end) Design

Date: 2026-07-29
Status: Approved (standing authorization)

## Goal

Wire the bias verifier's `biasReference` to a real cross-signal read — read the candidate's physical quantity (pose error) from an **independent** source (encoder) and compare against the candidate's own source (camera). This is the D7 cross-signal confirmation running for real: the same physical quantity measured by two independent signals, compared for systematic bias. With this, the D6 second gate is fully wired (not just injectable) — a candidate whose camera-measured pose error agrees with the encoder-derived pose error can reach `promotable`.

## Boundary

- Constructs `createPoseCrossSignalVerifier(deps)`: produces a `CandidateCrossSignalVerifier` that, for a candidate, reads pose error from two sources via the device readonly executor + the `pose_error_within` predicate machinery, then delegates to `createBiasDetectionVerifier` to detect bias.
- `measurementExtractor`: reads the candidate's source (e.g. camera) pose error samples — a readonly device command + regex (configurable per candidate via a map, or defaults to a standard `/pose` read).
- `biasReference`: reads the independent source (e.g. encoder) pose error via a different readonly command.
- Production wiring in `cli-main.ts` supplies the device readonly executor (already available as `liveRuntime.deviceSession`-derived). Offline (no device) → reads return null → biasReference null → conservative `false` (unchanged behavior).
- Does NOT hardcode a specific board's read commands. The commands come from config/deps (default reasonable, but a real board may need different `readCommand`/`valueRegex`). This slice proves the wiring; board-specific command tuning is content/config follow-up.

## Architecture

Add `src/acceptance/pose-cross-signal-verifier.ts`:

- `createPoseCrossSignalVerifier(deps: { deviceExecutor, cameraRead, encoderRead, biasTolerance? }): CandidateCrossSignalVerifier`
  - `cameraRead: { command, valueRegex }` — readonly command + regex for the camera source pose error.
  - `encoderRead: { command, valueRegex }` — readonly command + regex for the encoder source pose error.
  - Reads N samples from each (default N=5; production samples the last N terminal passes), parses numbers, feeds into `createBiasDetectionVerifier` with `measurementExtractor=camera samples`, `biasReference=encoder samples`.
  - No device / read returns null / parse fails → `false` (conservative; can't confirm).

Wire in `cli-main.ts`: replace `createBiasDetectionVerifier({ biasReference: () => null })` with `createPoseCrossSignalVerifier({ deviceExecutor, cameraRead, encoderRead })` where `deviceExecutor` is the live runtime executor (null when no board connected → conservative). `cameraRead`/`encoderRead` default to reasonable readonly commands (can be overridden by config later).

## Failure Semantics (D5/D6)

- No device → `false` (conservative).
- Either read unparseable → `false` (can't confirm; honest).
- Consistent bias between camera and encoder → `false` (D6: measurement invalid — U5 case).
- Camera and encoder agree → `true` (measurement-effectiveness confirmed → candidate could be promotable).

## Testing

TDD via `pose-cross-signal-verifier.spec.mjs`:
- Fake device returning camera error 8 and encoder error 0 (U5 bias) → `false`.
- Fake device returning camera and encoder both 2 (agree) → `true`.
- No device (null executor) → `false`.
- Unparseable camera read → `false`.
- Inject through `evaluatePromotion`: biased → non-promotable; agreeing → promotable (full D6 + D7 end-to-end).
- Existing cross-signal-bias-verifier and U5 specs still pass (additive).

## Follow-up

- Board-specific `cameraRead`/`encoderRead` command tuning (real ros2 topic echo / sysfs paths) — content/config task, needs a live board to validate.
- `video_fps_above` predicate (the last unimplemented geometric predicate).
- Contract materialization once a candidate reaches promotable on hardware.
