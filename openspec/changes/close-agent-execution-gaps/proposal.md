# Change: close Agent execution-boundary gaps

## Why

Custom tools can omit safety metadata and be inferred as readonly from their names, while a pre-tool hook can rewrite already validated input without a final schema check. Together these gaps allow a misleading extension name or hook mutation to bypass Plan-mode and input contracts.

## What changes

- Treat missing side-effect metadata as an untrusted local mutation rather than readonly.
- Revalidate input after global and registry pre-tool hooks.
- Run approval only after final normalization and validation.
- Allow automatic transient retries only for explicitly readonly tools.
- Correct the public extension example so deployment declares an external side effect.

## Out of scope

- A host-independent authenticated approval-token protocol.
- Persistent multi-tenant approval audit storage.
- Automatic idempotency keys for arbitrary third-party mutation tools; those tools execute at most once per call.
