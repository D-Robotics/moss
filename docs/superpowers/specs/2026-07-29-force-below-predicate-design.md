# force_below Geometric Predicate (current source) Design

Date: 2026-07-29
Status: Approved (standing "decisions all yours" authorization)

## Goal

Implement the first real geometric predicate so the self-evolution layer-3 cross-signal gate has a real measurement to confirm against (D6 ②). `force_below` is chosen first because it is a safety predicate (embodied arm current must stay below a threshold to prevent stall/collision), it is already referenced as a `safetyConstraints` entry in **5 existing contracts** (rdk-board-knowledge, rdk-embodied-lerobot, rdk-llm-deployment, rdk-peripheral-cookbook, rdk-ros) where it currently returns `unknown` — i.e. those safety constraints are not enforced today.

All 5 existing contracts use `source: 'current'` (motor current). `force_sensor` source is not used by any contract, so it is out of scope (YAGNI).

## Boundary

- Implements ONLY `force_below` with `source: 'current'`. `pose_error_within`, `joint_at`, `video_fps_above` remain `unknown` (separate slices).
- Does NOT implement `source: 'force_sensor'` (no contract uses it).
- Stays D5-safe: the predicate runs a **readonly** command via `deviceExecutor.runReadOnly` (which has a whitelist + dangerous-command guard). No device executor → `unknown` (no guessing, no fabricating a current value).
- The predicate must NOT invent how to read current on every board. Boards/motor-stacks differ. The contract's `params` must supply a `readCommand` (a readonly command that prints a current number) and a `currentRegex` (the regex extracting the number). Without them → `unknown` (honest, not a guess).

## Architecture

Extend `evaluatePredicate`'s `force_below` case (currently grouped with the not-implemented geometric predicates) to:

1. Read `threshold_n` (number) and `source` (`'current'`) from `spec.params`. If `source !== 'current'` → `unknown` (force_sensor not implemented).
2. Read `readCommand` (string, readonly command) and `currentRegex` (string, regex with a capture group) from `spec.params`. If either missing → `unknown` (`no_read_command` / `no_current_regex`).
3. If no `deviceExecutor` → `unknown` (`no_device`).
4. Run `readCommand` via `deviceExecutor.runReadOnly`. If it returns `null` (device unreachable or command rejected by readonly guard) → `unknown` (`device_unreachable`).
5. Apply `currentRegex` to `stdout`. If no match → `unknown` (`current_not_parsed` — honest, the measurement couldn't be read).
6. Parse the captured group as a number. Compare to `threshold_n`: below → `pass` (`force_below_threshold`), at/above → `fail` (`force_exceeds_threshold`), both with `evidence: { current, threshold_n }`, confidence `medium`.

This mirrors the existing `process_running` predicate shape (readonly command → parse stdout → verdict), so it follows established patterns.

## Params extension (additive)

`force_below` params now optionally accept:

- `readCommand: string` — readonly command printing the current value (e.g. `cat /sys/.../current` or `ros2 topic echo ...`).
- `currentRegex: string` — regex whose first capture group is the numeric current.

Existing contracts using `{ threshold_n, source: 'current' }` without these fields continue to return `unknown` (safe — they did before). Adding `readCommand`/`currentRegex` to those contracts is a follow-up content task, not part of this code slice.

## Failure Semantics (D5)

- No device / device unreachable / command rejected → `unknown` (no measurement; leave to layer-3 arbitration).
- `readCommand` missing / `currentRegex` missing / regex doesn't match → `unknown` (couldn't measure; never guess).
- Only a parsed number crossing `threshold_n` produces `pass`/`fail`. This is the D1 hard-signal principle: decide when you can measure, else `unknown`.

## Testing

TDD via `predicate-evaluator.spec.mjs`:

- `force_below` with no `readCommand` → `unknown` (`no_read_command`).
- `force_below` with `readCommand` but no device → `unknown` (`no_device`).
- `force_below` with a fake readonly executor returning `current: 12.3` → `pass` when `threshold_n=50`, `fail` when `threshold_n=10`.
- `force_below` with device returning null → `unknown` (`device_unreachable`).
- `force_below` with stdout that doesn't match `currentRegex` → `unknown` (`current_not_parsed`).
- `force_below` with `source: 'force_sensor'` → `unknown` (not implemented).
- Update the existing "geometric predicates return unknown" loop to exclude `force_below` (now implemented).

## Follow-up

- Add `readCommand`/`currentRegex` to the 5 existing `force_below` contracts so they actually enforce (content task, board-specific).
- Implement `joint_at` (joint encoder cross-signal — the U5 counterexample's second signal) and `pose_error_within` next.
- After a real cross-signal predicate exists, evaluate wiring it into `crossSignalVerifier` for promotion (D6 ②).
