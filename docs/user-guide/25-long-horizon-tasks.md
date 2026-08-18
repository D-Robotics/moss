# Long-horizon tasks

Moss records long-running work as an execution graph under
`.moss/runtime/executions/<task-id>/`. The graph is the shared state used by CLI, TUI, and Web: it
contains the goal, dependency nodes, assigned roles, visible budgets, workspace leases, evidence,
and the final verification verdict.

Use `/tasks` to list durable tasks. Use `/task inspect <id>` to see nodes and evidence,
`/task resume <id>` after reviewing recovered state, `/task retry <id> <node-id>` for a failed or
interrupted node, and `/task stop <id>` to cancel it. Recovered tasks default to
`paused_recovered`; external mutations interrupted during a crash are blocked and are never
automatically replayed.

One graph owner lease fences each scheduling wave. A second CLI/Web process cannot execute the same
task while that lease is live. Stop requests remain available to the user while a worker is active;
they abort the worker context and the cancelled graph cannot be revived by late success output.

Plans with explicit `dependsOn` edges run dependency-ready siblings concurrently. Omitting
`dependsOn` keeps the traditional ordered-plan behavior. Full-scope implementation sub-agents must
declare `writePaths`; they work in isolated snapshots and return patches for guarded parent merge.
Use the approval prompt for `merge_subagent_patch` to apply such a patch. Moss reloads the retained
artifact by ID and rejects undeclared paths, secret paths, stale parent files, or altered patch bytes.

Completion is evidence-first. Coding work needs a merged patch, a separate successful verifier,
and fresh green verification after the patch. Research needs citation/tool evidence; device work
needs a real probe receipt. Model prose cannot override a failed or missing deterministic check.
The same rule applies to embedding hosts: direct `ExecutionStore.append()` calls cannot issue a
verification verdict or complete a graph; those terminal events are reserved for the arbiter.

## Delivery cases and acceptance revisions

User-visible, cross-module, security, migration, plugin-permission, and device-mutation work can attach
a Delivery Case to the same graph. `low`, `medium`, and `high/critical` risk set minimum `minimal`,
`standard`, and `comprehensive` depth respectively; neither a model nor a plugin can lower that floor.
Standard and comprehensive cases require resolved structured clarification before a proposal. A
proposal may require explicit human approval before execution.

Every new implementation node that declares write paths must also declare at least one acceptance
criterion. Criteria have a revision. If the goal or criteria change, the revision advances, previous
verification becomes `STALE`, and fresh matching evidence is required. Non-minimal work also needs an
independent, read-only whole-change review. `FAIL` may create acceptance-bound fix nodes; `PARTIAL`
preserves evidence but never counts as completion. After a passing review and fresh graph verification,
Moss accepts a Completion Report containing requirement coverage, decisions, changed artifacts,
verification and review IDs, limitations, follow-ups, and measured cost/time fields.

Acceptance results are themselves structured `AcceptanceVerdict` records. A verdict names the exact
contract revision and existing evidence IDs; a `PASS` is rejected if any required criterion lacks
matching current-revision evidence. Revising the contract preserves the old decision as `STALE`.
Changing requirements advances the Delivery Case revision, removes the old proposal/report, and
returns the case to intake or elaboration before execution can continue.

Embedding hosts should use `ExecutionQuery` for reads and `ExecutionAction` for revision-checked
clarification, proposal, approval, acceptance, review, and report actions. Legacy Goal, Plan, Loop,
TaskRun, and `/api/tasks` paths remain temporary compatibility projections.

## Delivery Evidence Lab

`npm run evidence:delivery` runs the checked-in manifest for the seven required delivery
scenarios as paired control/treatment trials exactly five times. A manifest must lock task,
environment, model, and budget. The report records success, cost, token, wall time, retries, human
intervention, recovery, reviewer detection, failure classification, source revision, raw child
output, and stdout/stderr digests in `benchmarks/results/delivery-evidence-lab.json`. Override the
defaults with `--manifest` and `--output`. The checked-in deterministic scenario driver measures
harness mechanisms, not live-model quality; publish a model benchmark only with the underlying model,
runner, commit, configuration, and raw redacted logs.
