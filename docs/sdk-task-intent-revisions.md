# User corrections and task revisions

Enable `taskIntent: true` on `MossAgent` to reconcile real user input in the existing model response. This feature does not call a second classifier. It requires native structured tool calls; providers must expose `turn_decision` alongside ordinary tools.

```ts
const agent = new MossAgent({ ...config, taskIntent: true });
await agent.chat(sessionKey, rawText, {
  userInput: { id: stableUserMessageId, text: rawText, taskId },
  taskId,
});
// An internal planner/repair prompt is not a new user instruction.
await agent.chat(sessionKey, enginePrompt, { userInput: false, taskId });
// Admission persists the correction before returning its delivery receipt.
agent.steer(sessionKey, correction, { id: stableCorrectionId, taskId });
```

The model proposes field-level changes and a plan through `turn_decision` in its normal response. Runtime checks input identity, exact source quotations, schema and the captured revision before committing. Unmentioned fields survive. This validates protocol and provenance, not the semantic correctness of an interpretation. Ambiguous input should produce `clarify`, and capability questions should produce `answer`, with no business calls.

`getTaskIntent` returns the committed state plus the current pending-input barrier. `getTaskIntentReceipt` distinguishes semantic commit from canonical message delivery. Input IDs are session-scoped and must never be reused for different text. After the inbox payload limit, processed inputs retain compact hash/receipt tombstones so retries remain idempotent; these small identity records grow with the session.

With `sessionInboxDir`, input, receipt and the retryable task projection share the existing locked, fsynced inbox journal. A projecting entry blocks actions until recovery completes. Deterministically rejected projections remain failed/pending and may be superseded by a valid new input, including a fresh task binding. Storage errors fail closed.

Every action binds its original input sequence, intent revision and plan ID. Admission of newer input blocks remaining batch calls, approval continuations, automatic retries and stale task writes. Already-started external operations may finish; this mechanism does not roll back side effects. Suspended tools retain the existing explicit continuation protocol; hosts can admit a correction with `admitTaskInput`/`steer` before resuming, so the resumed model reconciles it before further actions.

For native tasks, `applyTaskRevision` commits a revision with an idempotent `revisionId` and `expectedRevision`. It retains the original goal for audit, invalidates the old plan and requires revision-matching evidence. `resumeTask(..., { replan: true })` plans before verification. Accepted task history is immutable. A PASS already dispatched at the native append boundary may finish settlement; later corrections belong to subsequent work.

Host callbacks outside normal tool execution must freeze the binding at callback creation and use `withTaskExecutionGuard(() => agent.assertTaskIntentCurrent(sessionKey, capturedIntent), action)`. Do not reread a new binding when an old callback wakes. Host evidence must also preserve its producing plan identity: stamping an old observation with the current revision does not make it current evidence.

Hosts that provision an isolated workspace can register `hooks.prepareToolBatch`.
The hook receives currently available, schema-checked business calls after the
runtime commits the pending decision. Use `assertCurrent()` before provisioning
and after each asynchronous step. The hook can update the host tool registry and
return a dispatch context with the new workspace. The SDK rechecks the decision,
resolves the updated tools and applies its usual approval and execution guards.
An answer or decision with no business calls skips the hook.

Each active constraint may have an exact author citation in `state.constraintSources`. A host can use that citation to bind an execution allowance to its originating input. `VersionedSessionStore.claimExecutionReceipt(scope, id)` atomically reserves a host action in a durable namespace. Call it when a validated operation is about to cross its dispatch boundary. A reservation only records admission and survives an uncertain or failed dispatch. Confirm the outcome from the transport or tool receipt.

The SDK defaults to the existing path when this option is absent. Studio enables it for ordinary runs, while fixed JSON execution profiles retain their own protocol.

Verification: `npm run verify` includes the `task-intent` stage, which exercises a scripted provider, durable recovery and native task revision/acceptance. These offline probes do not measure model interpretation accuracy or real-device behavior.

## Versioned context

Set `MOSS_VERSIONED_CONTEXT=1` for a CLI workspace, or supply
`new VersionedSessionStore(databasePath, legacyStore)` together with
`taskIntent: true` when embedding. Once initialized, the CLI reopens the same
database on later launches. The store is scoped by the host's account and session
identity. Close the agent before closing a store owned by the host.

- `/context sources` lists original message IDs, and `/context claims` shows
  recorded conclusions and their status.
- `/context correct <id> <text>` records a correction to an assistant message or
  claim. `MossAgent.correctContext(sessionKey, { id, targetId, text })` is the
  idempotent SDK equivalent.
- `/compact` prepares or selects a source-checked checkpoint. It preserves
  original source rows. `MossAgent.listContextSources` can inspect them after
  a restart. Imported sessions can only retain messages still present on disk.

The request pipeline progressively adjusts the output reservation, shortens old
tool results, prepares checkpoints in the background, reuses compatible
checkpoints, or performs bounded synchronous summarization. Provider-independent
admission uses a conservative serialized-size estimate. Provider-reported
overflow triggers a bounded retry with a smaller budget. Structured summaries
are historical data, and do not authorize work or commit acceptance.

On correction, the store invalidates dependent claims and supersedes all prior
checkpoint revisions. Legacy unstructured replies in the affected range are
excluded from the model view conservatively. In-flight provider responses and
business tool dispatch check their captured version. Tools already started can
have side effects. After an uncertain interruption their invocation record
remains unsettled. Use `/context unsettled` to inspect these records. After
checking the external state, record the observed outcome with
`/context reconcile <invocation-id> <observed outcome>` to resume mutations.

Run `node scripts/verify/cli.mjs --stage versioned-context,task-intent` for the
scripted provider and restart probes.
