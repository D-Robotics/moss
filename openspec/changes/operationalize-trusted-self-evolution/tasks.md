## 1. Environment identity

- [x] 1.1 Add versioned environment identity types, completeness rules, privacy-safe fingerprinting, and compatibility helpers.
- [x] 1.2 Probe fixed board/OS/BSP/firmware facts once per device connection and cache only runtime identity on the device session handle.
- [x] 1.3 Wire complete local/device identity into Experience, CandidatePatch, learning recall, and experiment assignment without logging raw values.
- [x] 1.4 Add tests for stable identity, changed board/firmware isolation, incomplete device fail-closed behavior, and probe redaction.

## 2. Configuration and operator reports

- [x] 2.1 Add a validated `.moss/evolution.json` loader with conservative defaults, bounded fields, and diagnostics.
- [x] 2.2 Extend experiment summaries with exposure, Wilson bounds, duration, token/cost, correction, failure-class, and rollback information.
- [x] 2.3 Add read-only `/evolution status|experiments|patch <id>|config` commands and localized usage/errors.
- [x] 2.4 Add command and report tests proving missing patches and inspection never mutate logs.

## 3. Structured trusted metrics

- [x] 3.1 Add optional World-authored `safetyCritical` metadata to AcceptSpec and validate it through Plan/contract entry points.
- [x] 3.2 Record structured terminal safety failure, safety reason code, and correction count from trusted task/run history.
- [x] 3.3 Prefer structured fields in experiment outcomes while retaining conservative legacy-v2 fallback behavior.
- [x] 3.4 Add tests for safety classification, fresh-evidence recovery correction counts, and immediate treatment demotion.

## 4. Lifecycle and documentation

- [x] 4.1 Add deterministic end-to-end tests covering trusted publication, shadow assignment, active rollout, demotion, rollback, and future-run exclusion.
- [x] 4.2 Update the self-evolution roadmap and user guide to distinguish implemented operations from remaining sim2real and multi-Skill work.
- [x] 4.3 Run OpenSpec strict validation, agent/core build, full Agent tests, and `git diff --check`.
