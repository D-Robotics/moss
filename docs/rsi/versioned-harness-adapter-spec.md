> Superseded boundary: see [native-evolution-engine-spec.md](native-evolution-engine-spec.md).
> The user now requires the optional generic evolution lifecycle in Moss.

# Versioned harness adapters for host-owned RSI

## Outcome

A host can evolve a bounded instruction artifact, evaluate it outside the agent
loop, select a version, and apply that exact immutable artifact to a native Moss
run. Existing observer events and the result identify the artifact actually used.
No learner, experiment runner, UI, account store or promotion authority enters
Moss core. Existing permissions, tool filters, provider choice and budgets retain
their enforcement authority.

## Contract

- `ChatOptions.harnessAdapter` is an optional `{id, version, instructions, sha256}`.
- The public hash helper hashes canonical JSON `[id, version, instructions]` as
  UTF-8 SHA-256. Instructions are bounded to 8 KiB and not silently trimmed.
- Validate and copy the adapter before the first asynchronous suspension of run
  admission. Prompt refreshes use that snapshot, never a later mutable object.
- Append the selected instructions to the stable prompt through the existing
  prompt composer. `omitExtraPromptLayers` does not discard an explicitly selected
  adapter. Existing callers without an adapter retain their behavior.
- Add an optional receipt `{id,version,sha256}` to the existing turn-start event
  and ChatResult, retaining the original event discriminants and observer hooks.
- Receipt attribution follows actual prompt use. A child that overrides its
  system prompt must not claim an adapter it did not receive.
- Task OS helper callers forward the optional adapter. No autonomous source-code
  rewriting, model-weight changes or automatic main merge is introduced.

## Verification

Native scripted-provider tests inspect the actual system prompt and receipts;
tampered hashes and invalid bounds fail before any model call. Mutating the input
during an await cannot change a run. Sequential and concurrent runs retain their
own adapter versions; no-adapter runs and overridden children do not inherit a
false receipt. Observer failures must retain existing isolation semantics.
Update protected SDK snapshots together with intentional public additions.
Run build, focused contract tests, examples and required repository checks;
report environmental failures without skipping or weakening assertions.

## Studio integration

Studio owns optional plugin enablement, account-scoped observations/candidates,
frozen evaluations, promotion and rollback. The first plugin can apply the same
artifact using the already public host prompt layer on its existing pinned SDK;
it must label that mode `host-prompt-layer`, rather than claim a native SDK receipt.
Native receipt mode is used only after consuming a released/accepted upstream
revision through the ordinary Studio pin update process. This avoids durable
private patches in Studio's `external/moss` and does not require publishing or
merging a feature branch merely to test the local plugin.
