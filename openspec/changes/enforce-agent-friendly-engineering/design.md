## Context

`fleet_batch` exposes `status`, `gather`, and `exec` under one static tool descriptor. Moss approval policy evaluates the descriptor before execution. `metadata.planMode === 'allow'` is an explicit bypass intended for planning-only runtime helpers; when combined with `sideEffectClass: 'device_mutation'`, it currently permits fleet execution during Plan mode.

The repository already owns a canonical `check` / `verify` hierarchy and a workspace hygiene checker. The change should strengthen those sources rather than add parallel workflow machinery.

## Goals / Non-Goals

**Goals:**

- Make all `fleet_batch` requests leave Plan mode before execution.
- Preserve normal Execute-mode behavior and existing command/path safety backstops.
- Make setup and verification discoverable and mechanically tied to repository scripts.
- Prove the relevant checker catches a deliberately broken contract.

**Non-Goals:**

- Adding input-dependent side-effect metadata in this change.
- Splitting `fleet_batch` into separate public tools.
- Changing the autonomous profile or broad device-approval defaults.
- Updating RDK Studio's Moss submodule pointer, publishing packages, or deploying.

## Decisions

### Mixed-action tools use the highest side-effect class

Until approval metadata can be resolved from the validated input without a time-of-check/time-of-use gap, a tool containing any device mutation is classified as a device mutation for every action. `fleet_batch` therefore uses `planMode: 'requires_user_confirmation'`.

This is intentionally conservative: `status` and `gather` also leave Plan mode. That cost is smaller than allowing arbitrary commands across a fleet. Input-dependent classification can be considered only if observed UX friction justifies the additional contract and tests.

### Existing repository policy owns documentation enforcement

`scripts/lib/workspace-policy.mjs` remains the reusable policy function and `scripts/test/workspace-policy.test.mjs` remains its meta-verification surface. Workspace hygiene invokes the policy against the real repository. The Agent entry adds exact setup/verification commands and success semantics; the policy checks command tokens plus explicit positive and empty-match semantics. The initial V0 checker intentionally recognizes the repository's current Chinese contract wording, so equivalent prose changes must update its negative fixtures as part of the same change.

### Host and runtime remain defense in depth

The upstream tool descriptor must be safe for Moss CLI and embedders. RDK Studio's permission boundary still independently maps `fleet_batch` to audited device mutation and blocks it in Plan mode. Neither layer relies on the other being present.

### Side-effect class overrides permissive Plan metadata

The approval boundary treats `sideEffectClass: 'device_mutation'` as authoritative. It rejects that class in Plan mode before consulting `metadata.planMode`, so an accidental future `planMode: 'allow'` cannot reopen device execution. Tests cover both the generic policy function and `fleet_batch` through the real `executeOneToolCall` path; the denial assertion includes a zero-execution counter.

## Risks / Trade-offs

- **Read-only fleet actions become unavailable in Plan mode** → accept for now; measure actual friction before adding request-level policy.
- **Documentation checks become brittle** → validate semantic command presence and manifest existence, not prose layout or exact wording.
- **A metadata-only test could miss approval-hook behavior** → exercise `executeOneToolCall` and assert both the outcome and dispatch count, in addition to descriptor and generic-policy tests.

## Migration Plan

1. Add a failing regression for the current `fleet_batch` descriptor.
2. Change its Plan-mode metadata, add the class-level approval guard, and run the focused package tests through the real execution pipeline.
3. Update repository entry documentation and workspace-policy fixtures.
4. Run standards, hygiene, package tests, and full repository verification.

Rollback restores the previous descriptor and documentation. It is not recommended because that reopens Plan-mode device execution.
