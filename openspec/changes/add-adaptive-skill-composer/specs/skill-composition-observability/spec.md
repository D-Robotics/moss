## ADDED Requirements

### Requirement: Composition trace records

The system SHALL emit a trace record for each attempted composition containing provider, registry snapshot identity, candidate identities and scores, final ordered identities, cardinality, rejection state, fallback reason, latency, and injected size estimate.

#### Scenario: Deterministic plan trace

- **WHEN** the deterministic provider returns a plan
- **THEN** the trace contains enough structured data to reproduce and score the selection decision without copying full skill bodies

### Requirement: Sensitive-data minimization

Composition telemetry MUST NOT duplicate full skill bodies, secrets, or unredacted task content when identifiers, hashes, reason codes, and bounded summaries are sufficient.

#### Scenario: Task containing a secret

- **WHEN** a task contains a value detected by existing redaction policy
- **THEN** the composition trace does not persist the secret

### Requirement: Plan-based evaluation

The evaluation harness SHALL score the actual composed and injected plan independently from explicit `load_skill` calls.

#### Scenario: Automatically injected correct skill

- **WHEN** the composer injects the expected skill and the agent never calls `load_skill`
- **THEN** composition selection is scored as correct and manual-load count remains zero

### Requirement: Required quality and efficiency metrics

Evaluation SHALL report Set F1, Set Exact Match, Recall@5, MRR, nDCG@5, cardinality error, dependency-violation rate, rejection accuracy, provider latency, fallback rate, injected token estimate, and downstream verifier pass rate.

#### Scenario: Multi-provider evaluation

- **WHEN** rules and model providers are evaluated on the same task suite
- **THEN** the report presents the required metrics by provider using the same task definitions and scoring rules

### Requirement: Segmented reporting

Evaluation SHALL support segmentation by task language, deployment mode, skill source, single/multi/no-skill class, and host/board environment.

#### Scenario: Chinese board-task analysis

- **WHEN** evaluation includes Chinese tasks executed in board mode
- **THEN** their selection, rejection, ordering, latency, and downstream results can be reported separately

### Requirement: Explicit rollout gates

The system SHALL keep a candidate provider in shadow mode until configured quality, safety, and latency gates are reviewed and explicitly approved.

#### Scenario: Candidate fails rejection gate

- **WHEN** a candidate provider improves Set F1 but falls below the required rejection-accuracy threshold
- **THEN** it remains non-controlling and the active provider is unchanged
