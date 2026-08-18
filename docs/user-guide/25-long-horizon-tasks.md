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
