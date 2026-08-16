# Design

`TaskRunLedger` is an instance-owned append-only projection. Its events carry a monotonic sequence;
the ledger validates state transitions and derives snapshots rather than persisting mutable status.
An optional JSONL file provides local durability. Recovery appends `run.interrupted` for non-terminal
runs, preserving history instead of rewriting it.

The Web host owns the ledger adapter. It records Web session admission, model execution, tool
evidence, errors, cancellation, and terminal outcome while the existing `MossAgent.streamChat()`
remains the only execution engine. `completed` and `verified` are deliberately separate: this slice
records completion as `unverified` unless a future trusted completion verifier emits evidence.
The durable ledger stores tool identity and outcome metadata, not tool inputs or result bodies;
full values remain in the existing session/stream boundary and are not duplicated into history.
