# Optional RSI SDK lifecycle

`RsiEngine` is independent of Studio. It stores bounded native execution metadata,
explicit cases, candidate instructions, frozen evaluations and the selected policy.
It never changes model weights, tools, approvals or permissions.

```js
import { RsiEngine, createRsiLearningProvider } from '@rdk-moss/agent';

const engine = new RsiEngine({
  rootDir: privateOperatorDirectory,
  authorize: (scope) => assertAdmittedOwner(scope),
  learning: createRsiLearningProvider({
    model,
    identityDigest: modelAndEndpointDigest,
    createProvider: () => configuredProvider,
  }),
});
const selected = engine.captureAdapter(scope, {
  model,
  providerIdentityDigest: modelAndEndpointDigest,
});
// Create a run observer and forward real root SDK onAgentLoopEvent callbacks.
// It starts recording only after the matching native turn_start receipt.
const result = await agent.chat(sessionKey, userTask, {
  runId,
  harnessAdapter: selected?.harnessAdapter,
});
// Finish observation using the real host task verdict, not model success prose.
```

Use `enrollCase` with actual terminal observed runs and independent immutable
training/validation/holdout splits. `propose` receives no holdout. `evaluate`
consumes holdout before model calls; deletion/expiry cannot reset exposure.
`promote` requires the same candidate/baseline, case hashes, provider/evaluator
identity and policy CAS; `rollback` affects only later tasks.

The convenience evaluator checks next recovery action. For actual tasks inject
`createRsiTaskEvaluator({ model, evaluatorVersion, runCase })` as the learner's
`evaluate` implementation and declare that same evaluator version. `runCase`
reuses the host's real MossAgent and independent verifier, returning verified
`passed`, count metrics and actual model-call spend. Labels/splits/private case
IDs are withheld. Both arms get identical fixed per-arm budget limits and their
order is counterbalanced. There is no second agent runtime or scheduler.

Correctness-only ties cannot promote. Optional efficiency criteria must be frozen
before execution: both arms correct for every case, no per-case count regression,
and an independently heldout aggregate reduction of at least
`minimumAbsoluteGain`. Missing/non-integer counts and overspending fail closed.
An efficiency result is not a task-success-rate improvement claim.

Provider identity hashes provider/model/endpoint, excluding credentials and the
evaluator. The default evaluator identity hashes its implementation settings;
custom hosts must supply an implementation/oracle-bound `evaluatorVersion`.

The default store is `.moss/runtime/rsi`; importing or reading status does not
create files. Custom directories must be private and owned by the admitting host.
Credentials must stay in runtime environment/provider configuration. Native events
retain only allowlisted metadata; raw prompts, thinking and tool data are omitted.

Run `node examples/rsi-sdk.mjs` for an offline, scripted API wiring example. Its
controlled scores are not model-quality or hardware evidence. Connected-board
acceptance requires actual SSH execution and an independent task oracle.
