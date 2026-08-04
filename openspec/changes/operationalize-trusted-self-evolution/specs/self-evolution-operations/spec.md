## ADDED Requirements

### Requirement: Device experiments use complete privacy-preserving environment identity
The system SHALL derive a versioned environment fingerprint from a fixed trusted device probe and SHALL persist only the fingerprint and completeness metadata in self-evolution records.

#### Scenario: Complete device identity is eligible
- **WHEN** a connected device provides a board model and at least one OS, BSP, kernel, or firmware version signal
- **THEN** the system produces a stable non-unknown fingerprint without persisting host, user, prompt, or raw probe output

#### Scenario: Incomplete device identity fails closed
- **WHEN** a device task has no board model or no version signal
- **THEN** the system marks its automatic-learning environment unknown and excludes it from publication and A/B assignment

#### Scenario: Environment change isolates evidence
- **WHEN** the board model or version identity changes for otherwise identical tasks
- **THEN** the resulting fingerprint changes and outcomes are not pooled

### Requirement: Experiment thresholds are validated workspace configuration
The system SHALL load optional workspace experiment thresholds, validate finite bounded values, and use conservative defaults for missing or invalid fields.

#### Scenario: Valid configuration is applied
- **WHEN** `.moss/evolution.json` contains valid supported threshold values
- **THEN** new experiment evaluations use those effective values and the status report identifies their workspace source

#### Scenario: Invalid configuration cannot weaken guardrails
- **WHEN** a threshold is negative, non-finite, out of range, malformed, or unknown
- **THEN** the system reports a diagnostic and uses the safe default for that field

### Requirement: Operators can inspect self-evolution without mutation
The system SHALL provide read-only CLI commands for overall status, experiment listing, patch detail, and effective configuration.

#### Scenario: Status summarizes trusted lifecycle
- **WHEN** an operator runs `/evolution status`
- **THEN** the output reports patch and experiment lifecycle counts plus evidence/log availability without exposing raw prompts, stdout, device identity, host, or user data

#### Scenario: Patch report exposes decision evidence
- **WHEN** an operator runs `/evolution patch <id>` for an existing patch
- **THEN** the output includes arm sample counts, success intervals, retry/tool/duration/token/cost metrics, safety failures, decision reason, exposure, and rollback state

#### Scenario: Unknown patch is non-mutating
- **WHEN** an operator requests a missing patch identifier
- **THEN** the command returns a clear error and does not create or modify any evolution record

### Requirement: Terminal outcomes carry structured correction and safety metrics
The system SHALL record first-class correction counts and safety-failure classification on new v2 terminal outcomes and SHALL prefer these fields during experiment aggregation.

#### Scenario: Failed safety predicate is classified
- **WHEN** a terminal predicate marked `safetyCritical` returns fail
- **THEN** the terminal record contains `safetyFailed=true` and a stable safety reason code, and a treatment outcome is immediately eligible for demotion

#### Scenario: Recovery records prior corrections
- **WHEN** a task succeeds after one or more trusted terminal failures with fresh evidence
- **THEN** its terminal and experiment outcomes record the number of corrections issued rather than estimating only from generic tool retries

#### Scenario: Legacy v2 outcome remains readable
- **WHEN** an older v2 terminal record lacks structured correction or safety fields
- **THEN** the system can audit it with conservative compatibility inference without rewriting the record

### Requirement: The full learned-Skill lifecycle is regression tested
The system MUST test publication, shadow assignment, objective activation, safety/regression demotion, and rollback using trusted v2 evidence.

#### Scenario: Credible benefit activates future treatment
- **WHEN** a published learned Skill accumulates sufficient trusted control and treatment outcomes with statistically credible benefit and passing guardrails
- **THEN** it becomes active and future eligible runs receive treatment

#### Scenario: Safety failure rolls back a published artifact
- **WHEN** a trusted treatment outcome reports a structured safety failure
- **THEN** the patch is demoted, its learned artifact is rolled back through the path-scoped coordinator, and future runs are excluded
