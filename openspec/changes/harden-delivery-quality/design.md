# Design: Moss delivery-quality hardening

## Done

1. Provider/auth/rate/upstream/abort errors retain a sanitized `{code,message,hint?,recoverable}` outcome through agent loop, public stream, `chat()`, headless output and CLI exit mapping.
2. Encrypted configuration reads never create a new key. Missing, malformed or mismatched key material fails closed as configuration error with a recovery hint; ciphertext is never sent to a provider.
3. Oneshot and piped CLI install one cancellation owner, forward its `AbortSignal` to `streamChat`, await cleanup, and terminate with `USER_ABORTED` semantics.
4. A session has one cross-process mutation owner or a transactional mutation interface; stale load/replace cannot overwrite another process's acknowledged append.
5. `create-moss-app` resolves core+agent as one compatible release set. If either registry query fails, both use the same checked fallback version.
6. Release preflight requires clean tree, full verify/API/packed-consumer evidence, stages all packages under a temporary dist-tag, verifies exact versions/ranges, then promotes from one repository-wide trusted coordinator; prereleases never use `latest`.
7. Focused tests, `npm run check`, real CLI smokes and `npm run verify` pass.

## Interfaces

### StructuredErrorOutcome

Sanitized stable fields only. Causes, stacks, raw provider bodies and secrets stay inside the implementation. Unknown errors become `UNKNOWN`; an adapter may render localized prose but cannot replace the code.

### EncryptedCredentialStore

Write path may create key material atomically. Read path requires existing 32-byte key material and valid AEAD payload; every failure is explicit and side-effect free.

### CancellationOwner

Exactly one AbortController per CLI run. First SIGINT aborts and begins bounded cleanup; a second may force termination. Providers, tools and session finalization observe the same signal.

### SessionMutationOwner

Read-observe-mutate is the transaction surface. An atomic cross-process lease serializes each
filesystem mutation, and optimistic content versions prevent a stale store instance from replacing
or appending over another process's acknowledged state. Conflicts fail closed instead of merging
unrelated turns.

### MossReleaseSet

Core and agent share one version decision. Registry resolution, fallback, staging and promotion operate on the set, never independently.

## Edge states

- Missing terminal event plus a structured error remains an error, not success.
- JSON output carries stable error identity without exposing stack/context secrets.
- Config key loss does not overwrite the missing key or modify config.
- SIGINT during provider wait and tool execution reaches finally blocks.
- A session owner is recovered only after same-host process liveness proves its PID is dead and a
  token-verified recovery mutex is held. A live/reused PID, malformed owner, or unverifiable state
  fails closed; recovery-owner crashes use the same proof before takeover.
- Partial npm publish never advances the public stable tag.

## Verification

- Local HTTP provider returns 401/429/500 and CLI exits 4/5/6.
- Delete/corrupt `.apikey-key`; config command exits 3 and config/key filesystem digest is unchanged.
- Spawn oneshot against a delayed provider, send SIGINT, observe cancellation event/cleanup and exit 11.
- Two child processes mutate one session; competing owner fails closed or all acknowledged writes remain.
- Force one npm lookup to fail; generated core/agent ranges are identical and install/typecheck.
- Fake registry rejects the second package; stable tag remains unchanged.

## Risks

- Adding fields to public stream events is additive but still requires API report review.
- Session ownership changes resume behavior; conflicts must be actionable and recoverable.
- npm registry promotion is tested with a fake adapter; real publish remains a human-triggered L3 action.
