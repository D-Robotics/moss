# Design

## Decisions

### Unknown metadata is conservative, not guessed safe

Known read and mutation verbs remain compatibility hints, but an unrecognized name with no metadata resolves to `local_write`. Plan mode rejects it because it lacks an explicit `planMode: allow`; Execute mode still offers the normal approval path.

### Validation happens at the execution boundary

The pipeline order is: initial schema validation → global normalization hooks → validation → registry hooks → final validation → approval → execute. The final approval request and tool implementation receive the same validated object.

### Retry requires explicit read-only semantics

`transientRetry` is an availability hint, not an idempotency declaration. The executor therefore requires `sideEffectClass: readonly` in addition to the retry hint or built-in retry allowlist before it performs an automatic retry.

## Risks and mitigations

- Legacy custom tools may prompt or be denied in Plan mode: this is intentional fail-closed behavior; add explicit metadata.
- Hook ordering changes: focused tests prove invalid rewrites never reach approval or execution.
- A legacy tool on the retry allowlist without explicit `readonly` metadata stops retrying: the safer failure mode is a visible single-attempt error until its metadata is corrected.

## Rollback

Rollback is not recommended because it restores both bypasses. A compatibility exception must instead declare explicit metadata and add a contract test.
