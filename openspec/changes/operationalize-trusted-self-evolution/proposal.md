## Why

Moss has a trusted self-evolution loop and learned-Skill A/B engine, but its runtime identity is too coarse and its experiment state is not operable from the CLI. The next step is to make real deployments safely measurable: bind evidence to board and firmware identity, expose auditable experiment reports, and prove the full published-to-activation-or-rollback lifecycle.

## What Changes

- Derive privacy-preserving environment fingerprints from stable workspace, runtime, board model, OS/BSP, and firmware facts, with explicit completeness metadata.
- Prevent promotion and experiment reuse when required device identity is missing or changes.
- Add read-only CLI commands for self-evolution status, experiment listing, and per-patch reports.
- Add workspace-configurable experiment thresholds with validation and conservative defaults.
- Record first-class correction counts and structured safety classifications instead of relying only on retry or reason-text inference.
- Add end-to-end lifecycle tests for published learned Skills reaching shadow, active, demoted, and rollback states.
- Reconcile the self-evolution roadmap with implemented behavior and document the remaining sim2real and multi-Skill boundaries.

## Capabilities

### New Capabilities

- `self-evolution-operations`: Environment identity, operator-facing experiment inspection/configuration, structured outcome metrics, and lifecycle validation for trusted learned Skills.

### Modified Capabilities

None.

## Impact

- Affects Moss Agent CLI composition, device environment discovery, trusted learning and experiment logs, terminal arbitration metrics, configuration validation, and self-evolution tests.
- Adds read-only user-facing commands and optional workspace configuration; existing logs and default behavior remain compatible.
- Does not enable sim2real promotion, multi-Skill proof allocation, automatic acceptance-contract mutation, or unrestricted learned code execution.
