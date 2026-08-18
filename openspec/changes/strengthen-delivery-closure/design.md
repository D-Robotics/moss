# Design

## One authority

`DeliveryCaseSnapshot` is a projection embedded in `ExecutionGraphSnapshot`. Delivery transitions,
acceptance revisions, reviews, and reports are immutable execution events guarded by revision CAS.
`ExecutionQuery` and `ExecutionAction` are the shared host seams; they do not persist parallel state.

## Risk-adaptive depth

Low-risk work may remain `minimal`. Medium risk has a `standard` floor. High and critical risk have a
`comprehensive` floor. A caller may increase rigor but cannot lower the policy floor. Standard and
comprehensive proposals require resolved elaboration; approval remains explicit when required.

## Acceptance and review

Mutating implementation nodes require a non-empty acceptance contract. A new contract revision marks
the previous verification stale and reopens a completed graph. Deterministic failure dominates semantic
review. Non-minimal delivery requires the latest whole-change review to be independent, read-only, and
`PASS` or `PASS_WITH_NOTES`. Failed reviews may add acceptance-bound fix nodes atomically.

## Product surfaces

The Web control plane exposes `/api/executions` and revisioned actions while retaining `/api/tasks` for
compatibility. The details panel renders delivery stage, DAG, acceptance, review, evidence, and report
with explicit loading, empty, error, retry, and stale semantics. Built-in dialogs replace browser-native
prompt and confirm surfaces.

## Evidence policy

Completion reports are accepted only after graph verification and refer to structured requirement,
review, artifact, and evidence identifiers. Benchmark results are published only when raw runs and
configuration are retained; mechanism tests are not represented as real-model benchmark wins.
