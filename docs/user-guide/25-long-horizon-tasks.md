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

Plans with explicit `dependsOn` edges run dependency-ready siblings concurrently. Omitting
`dependsOn` keeps the traditional ordered-plan behavior. Full-scope implementation sub-agents must
declare `writePaths`; they work in isolated snapshots and return patches for guarded parent merge.

Completion is evidence-first. Coding work needs a merged patch, a separate successful verifier,
and fresh green verification after the patch. Research needs citation/tool evidence; device work
needs a real probe receipt. Model prose cannot override a failed or missing deterministic check.
