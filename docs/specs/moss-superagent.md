# Moss Super-agent — executable specification

Status: implemented and accepted (local CLI/SDK scope). Branch: `codex/moss-superagent`.
Baseline: Moss `7e6673de2738cb08296d3184720c4f55bed0a910` (0.28.0).
Upstream: DeepSeek `dsh-superagent-prototype` `6337fc823ce20251c8de8085948165c81aaa701e`, MIT.

## Outcome and scope

Moss shall optionally use the real upstream Super-agent domain engine to admit requests, record immutable mandates, dispatch isolated Moss workers and recover durable work. Moss remains the provider/tool/session/safety/acceptance runtime. No DSH, Cordis, Web server or new npm runtime dependency is introduced.

This explicitly unfreezes only optional local/SDK request admission and ticket coordination in AGENTS.md. Memory, mesh, Web UI, plugin markets, GitHub/Feishu connectors and automatic external publishing remain outside this change. Their Sources can be added later through the SDK. The implementation must not post, push, merge or operate real devices for acceptance.

## CLI and SDK

- `moss superagent init --accept '<command>'`: configure a committed Git workspace and a trusted, fixed acceptance command. Default inferred acceptance mode: observe; default local actor: operator; default concurrency: 1. Repeating an identical initialization preserves state; changing policy requires an explicit configuration operation.
- `moss superagent submit '<goal>' [--id <event-id>]`: atomically store an explicitly authorized local request. Replayed event IDs cannot create duplicate tickets or silently replace text.
- `moss superagent work`: drain admitted work in the foreground. `start` keeps polling for newly submitted work until cancelled.
- `status [ticket-id]`: inspect tickets, native task/worktree/session bindings and local replies without a model call. An uninitialized status creates no runtime directory.
- `pause` / `resume`: durably hold/release new launches. `stop <ticket-id>` revokes that ticket; `retry <ticket-id>` explicitly recovers a blocked/failed assignment in its original workspace and session.
- Public SDK provides the same engine-backed runtime and typed request/worker contracts. Custom Sources authenticate actors before constructing requests; plain external text cannot configure policy, command, permissions or identity.

## Reuse and layering

1. Vendor only the transitive dependency closure of upstream `src/core/index.ts`, with upstream license, full revision and checksums. Convert relative .ts imports to .js and format for Moss; compatibility-only adaptations are listed in the provenance manifest. Preserve domain behavior; tests detect provenance drift. Do not import the upstream plugin entry or rewrite a look-alike engine.
2. A synchronous SQLite repository implements the engine ports and durable effect/local-outbox records. Domain changes and queued side effects commit in one transaction; side effects execute after commit. Do not represent a multi-record commit as ordinary JSONL appends.
3. `MossExecutor` uses one child process per active ticket. It uses `spawnProcess`, the ordinary CLI agent initialization, native Moss sessions/inbox and Task Runtime. No duplicate provider/tool/security bootstrap.
4. Admission uses deterministic sender/source checks before semantic assessment. Explicit requests need an allowed human addressing the agent. Inferred work needs a configured assessor and enabled written rules; observe records a would-accept decision without launching. No-assessor/invalid model response fails closed.
5. The local outbox is a durable SDK/CLI result surface; no external transmission occurs automatically.

## Execution and authority

- Each ticket has one stable, separate Git worktree and Moss session. It includes the committed repository snapshot, not uncommitted parent changes. No automatic patch merge or deletion of worktrees.
- Trusted acceptance command lives outside model decisions and survives restart. Worker success requires native Task Runtime acceptance with that command; assistant text, child exit alone and a forged summary cannot report ready.
- A ready result closes a local ticket with no followed PR; the upstream engine continues to own any explicitly bound PR lifecycle. Native task acceptance and ticket lifecycle are distinct.
- Follow-up delivery is idempotent and durable. Worker inputs are marked read only after canonical native consumption or the completed native turn. Context-only events carry no new authority. They cannot change the oracle or widen worker permissions.
- Workers retain Moss workspace-write/device safety and budget limits. Cancellation targets only the corresponding worker. Cooperative IPC cancellation precedes a bounded shutdown fallback; an interrupted or forced shutdown is not reported as success.
- Only one foreground scheduler may own a state directory. Status/submission/control may use separate short-lived connections. After a scheduler crash, uncertain running work is blocked for explicit retry; restart does not blindly replay commands. Recovery reuses the worktree/session and inspects persisted native task evidence before continuing.
- State paths and worktree roots refuse symlink escapes. State and controller data are private to the OS user; secrets stay in environment/provider configuration, never in the database, IPC logs or published evidence.

## Acceptance scenarios

- [x] A1. A real upstream Engine accepts an authorized request, produces a mandate and one ticket; replayed ID creates no second execution, while changed duplicate content is rejected.
- [x] A2. Disallowed actor/source, context-only request and invalid assessment launch no worker. Observe records an inferred positive assessment without executing; auto requires a matching configured rule.
- [x] A3. A real isolated Moss worker calls a tool, changes a disposable Git worktree and passes an independent acceptance command. Parent checkout stays unchanged and native task/session evidence exists.
- [x] A4. A failing oracle or false completion statement never produces ready. The operator command cannot be replaced by model output or follow-up text.
- [x] A5. Stop/retry, pause/resume and two independent workers preserve cancellation and filesystem isolation. Pending input replay is idempotent.
- [x] A6. Restart preserves tickets, policy, replies, worktree and session bindings. Interrupted work is not auto-replayed; explicit retry resumes or honestly blocks without duplicate completion.
- [x] A7. CLI help/status work without credentials, invalid arguments fail nonzero, and public SDK snapshot/examples remain valid. The optional module does not change normal chat/task behavior.
- [x] A8. Upstream provenance, typecheck, formatting, lint, package tests, CLI smoke and examples pass. Run native-process protocol/oracle tests offline; an actual remote LLM run is reported separately and only uses explicitly configured credentials.

## Evidence and rollback

Record exact commands/results and residual platform/provider limitations in `docs/specs/moss-superagent-acceptance.md`. Scripted providers can verify the real Moss loop/tool/oracle path but are not evidence of remote-model performance. Do not label unrun Linux/Windows/device tests passed.

Rollback disables the optional command/SDK entry. Existing Moss tasks/sessions and the separate Super-agent state/worktrees remain readable; removing code must not delete user work.
