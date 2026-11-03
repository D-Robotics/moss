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

For a preregistered experiment, call `freezeProtocol` after enrolling all cases
and before calling the learner. It writes an immutable plan without model calls:

```js
const protocol = engine.freezeProtocol(scope, {
  caseIds: allCasesInExecutionOrder,
  budget,
  criterion: { kind: 'efficiency', metric: 'toolCalls', minimumAbsoluteGain: 1 },
  runtimeConfig: {
    runnerVersion,
    oracleVersion,
    modelConfigDigest,
    tools: orderedToolNames,
    permissionsDigest,
  },
});
const candidate = await engine.propose(scope, {
  caseIds: allTrainingCasesInProtocolOrder,
  budget,
  protocolId: protocol.id,
  runtimeConfig: effectiveRuntimeConfig,
});
const evaluation = await engine.evaluate(scope, candidate.adapter.digest, {
  caseIds: allCasesInExecutionOrder,
  budget,
  criterion: protocol.criterion,
  protocolId: protocol.id,
  runtimeConfig: effectiveRuntimeConfig,
});
// Only after evaluation.status === 'passed' and explicit host authorization:
engine.promote(scope, candidate.adapter.digest, {
  evaluationId: evaluation.id,
  expectedPolicyVersion,
  protocolId: protocol.id,
  runtimeConfig: effectiveRuntimeConfig,
});
```

The host derives each runtime declaration from effective trusted settings, never
from a browser's claim of tools, permissions or verifier code. Model settings and
permissions are bounded SHA-256 declarations; runner/oracle versions and ordered
tool names are stored explicitly. The SDK compares them at generation, evaluation
and promotion; it cannot independently inspect a custom host's execution port.
The plan also binds the current model/provider/evaluator identity, policy, complete
case digests, criterion, total budget and equal per-arm allocation. Changing one
requires a new plan. A proposal is claimed durably before the model call, including
when the provider fails; the same plan cannot generate another candidate.

Bound candidates cannot be evaluated or promoted through the legacy unbound path.
Imported candidates cannot acquire a protocol retroactively. Old schema-2 state
and calls without a protocol remain supported and are explicitly unregistered
evidence. `listProtocols` returns saved plans; `rsiProtocolDigest` verifies their
canonical identity. No raw model configuration or credentials belong in a plan.

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
