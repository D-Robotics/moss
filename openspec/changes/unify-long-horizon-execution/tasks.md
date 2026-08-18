## 1. Execution graph

- [x] 1.1 Define beta graph, node, event, evidence, policy, and store contracts.
- [x] 1.2 Implement in-memory CAS, transition validation, leases, recovery, and projection.
- [x] 1.3 Implement JSONL durability, locking, fsync, snapshots, corrupt-tail repair, and migration markers.
- [x] 1.4 Project `TaskRunLedger` and remove module-level Plan state.

## 2. Scheduling and isolation

- [x] 2.1 Implement dependency-driven readiness, concurrency, budgets, retries, and failure propagation.
- [x] 2.2 Implement Git worktree and copy-snapshot workspace lease adapters.
- [x] 2.3 Produce patches, digests, verification evidence, guarded merge, and retained recovery.

## 3. Expert team and completion

- [x] 3.1 Add capability-based role routing and structured assignment results.
- [x] 3.2 Add coverage/conflict synthesis and independent verifier scheduling.
- [x] 3.3 Add deterministic-first completion arbitration with evidence-bound verdicts.
- [x] 3.4 Add atomic plugin role contribution with isolated-write authorization.

## 4. Product integration and migration

- [x] 4.1 Add graph-backed MossAgent configuration and async task compatibility.
- [x] 4.2 Add `/tasks` and `/task inspect|resume|retry|stop` commands.
- [x] 4.3 Expose the same graph identity, sequence, evidence, and verdict to Web, TUI, and ACP.
- [x] 4.4 Import legacy TaskRun, Goal, TaskFrame, Plan, and Loop files without deleting originals.

## 5. Evidence and delivery

- [x] 5.1 Cover state, restart, DAG, workspace, expert, plugin, and completion negative cases.
- [x] 5.2 Run real CLI/Web paths and record 10/10 long-task plus 10/10 concurrency evidence.
- [x] 5.3 Update API reports, Architecture, extension/user docs, and changelog.
- [x] 5.4 Pass focused tests, `npm run check`, CLI smoke, `npm run verify`, and three-platform CI.
