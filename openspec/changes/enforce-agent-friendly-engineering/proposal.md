## Why

Moss already has strong build, test, API, and workspace gates, but two gaps keep the repository from meeting its own Agent-friendly contract. A fresh coding agent is not told how to perform a lockfile-faithful setup or what command success means, and the mixed-action `fleet_batch` tool declares Plan-mode access even though its `exec` action mutates multiple devices.

## What Changes

- Make the root Agent entry declare setup, focused, fast, and full verification with explicit success contracts.
- Make README development setup reproducible from `package-lock.json`.
- Extend workspace policy tests so contributor-entry commands cannot silently drift from the root manifest.
- Classify `fleet_batch` conservatively as requiring execution mode and the normal approval path.
- Add a class-level fail-closed guard so every `device_mutation` remains blocked in Plan mode even if a future descriptor accidentally declares the planning bypass.
- Exercise the real tool-call pipeline to prove Plan denial performs zero dispatches and Execute mode still dispatches once, while preserving dangerous-command and shell-escaping checks.

## Capabilities

### New Capabilities

- `agent-friendly-engineering-contract`: Reproducible repository entry and fail-closed Plan-mode handling for mixed device tools.

### Modified Capabilities

None.

## Impact

- Affects repository instructions, workspace hygiene policy/tests, README development commands, and `fleet_batch` metadata/tests.
- Does not change Execute-mode fleet command behavior, the danger-command backstop, public API shapes, package boundaries, or release state.
- RDK Studio keeps its independent host-side Plan-mode and approval defenses; submodule bumping remains a separate upstream integration step.
