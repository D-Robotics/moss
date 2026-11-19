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

The SDK defaults to the existing path when this option is absent. Studio enables it for ordinary runs, while fixed JSON execution profiles retain their own protocol.

Verification: `npm run verify` includes the `task-intent` stage, which exercises a scripted provider, durable recovery and native task revision/acceptance. These offline probes do not measure model interpretation accuracy or real-device behavior.
