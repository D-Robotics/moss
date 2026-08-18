# Change: unify long-horizon execution and expert work

## Why

Moss currently records Goal, TaskFrame, Plan, Loop, Web task runs, and background work through
separate state owners. That is sufficient for bounded single-process work, but it cannot safely resume
one authoritative task after restart or let implementation experts return isolated changes with
machine-checkable evidence.

## User outcome

- One graph identity and ordered event stream describes a long-running task in CLI, TUI, Web, and ACP.
- A restarted local host recovers unfinished work as paused without replaying uncertain mutations.
- Independent expert assignments run concurrently when dependencies and declared write paths permit.
- Implementation assignments write only in retained workspace leases and return patches for guarded merge.
- Completion and verification cite concrete evidence; missing evidence pauses instead of accepting model text.

## Non-goals

- Distributed or multi-user scheduling, remote high availability, or an external workflow engine.
- Recursive worker delegation or direct concurrent writes into the parent workspace.
- Automatic replay of interrupted external mutations.
- A plugin marketplace or sandbox claim for trusted third-party JavaScript.

## Compatibility

`TaskRunLedger`, Goal, TaskFrame, Plan, Loop, and `MossAsyncTaskRegistry` remain readable during one
release cycle. New runtime writes are projected from the execution graph, with legacy files imported
non-destructively and marked after successful migration.

