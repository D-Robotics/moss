# Design

## Authority and storage

`ExecutionGraph` is an instance-owned event-sourced aggregate. `ExecutionStore` owns persistence and
compare-and-set revision checks. `JsonlExecutionStore` writes one graph directory under
`.moss/runtime/executions/<graph-id>/`, repairs only an invalid JSONL tail, snapshots every 100 events,
and uses a renewable owner lease to prevent two local hosts from advancing the same graph.

All recovery is fail-closed. Restarted graphs enter `paused_recovered`. Read-only nodes without side
effects may be made ready by an explicit policy; interrupted external mutations become blocked.

## Scheduling

The scheduler derives readiness from dependencies rather than step number. It admits at most the
configured concurrency, rejects overlapping normalized write paths, preserves successful siblings,
and pauses on explicit token, cost, or wall-time budget exhaustion. Three consecutive occurrences of
the same failure fingerprint block a node.

## Workspace leases

Git workspaces use detached worktrees seeded from a captured base commit, followed by the parent's
staged/unstaged changes and non-ignored untracked files. Non-Git and unborn repositories use a filtered
copy snapshot. Secrets, `.env`, `.git`, `.moss`, and build caches are excluded. A worker returns a patch
and evidence; parent files are hash-checked before the patch passes existing safety and approval seams.
Unmerged leases survive restart and are removed only after merge, rejection, or cancellation.

## Expert roles

Legacy `SubagentExpertDefinition` remains the read-only advisor interface. `AgentRoleDefinition` adds
advisor, implementer, and verifier roles with capability, tool, budget, workspace, and structured-result
contracts. Plugins may register roles atomically, but isolated-write implementers require explicit host
authorization. Workers cannot delegate further.

## Completion

`CompletionArbiter` combines dependency state, pending work, lease/merge state, acceptance predicates,
fresh verification, and requirement coverage. Deterministic failures dominate semantic model judgment.
Strict mode returns `blocked/needs_evidence`; a verified verdict always cites evidence identifiers.

## Migration

Preview mode shadow-writes the graph while legacy projections remain authoritative. Authority mode
writes only through the graph and exposes legacy adapters. Importers preserve original files and write a
migration marker only after a successful append.

## Do not touch

- Tool side-effect metadata, approvals, stale-read protection, and error boundaries remain authoritative.
- Plugin registration/disposal remains atomic and instance-owned.
- Read-only expert tool filtering remains fail-closed.

