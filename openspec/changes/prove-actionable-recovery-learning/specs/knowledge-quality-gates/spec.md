## ADDED Requirements

### Requirement: Reject non-actionable learned knowledge
Before publication, the system MUST verify that a recipe contains executable procedural detail, machine-checkable evidence, and a correction not already fully subsumed by the base Skill. Failed gates SHALL produce stable reason codes including `insufficient_procedural_detail`, `insufficient_novelty`, and `subsumed_by_base_skill`.

#### Scenario: Candidate contains only tool names
- **WHEN** a candidate contains a sequence such as `exec -> exec` without operations, bindings, and evidence checks
- **THEN** publication is rejected as `insufficient_procedural_detail`

#### Scenario: Base Skill already contains the same correction
- **WHEN** all material operations and safety checks in a candidate are already required by the active base Skill
- **THEN** publication is rejected as `subsumed_by_base_skill`

### Requirement: Require independent and applicable evidence
The system SHALL require independent recoveries and MUST reject a recipe whose applicability cannot be separated from one concrete host or run. Unknown environments and duplicate evidence SHALL not satisfy generalization requirements.

#### Scenario: All recoveries replay one evidence item
- **WHEN** multiple events share an attempt or evidence identity
- **THEN** they count as one independent recovery

#### Scenario: Candidate embeds one machine's concrete state
- **WHEN** a candidate cannot replace environment-specific values with validated selectors and bindings
- **THEN** publication is rejected as `overfit_to_single_environment`

### Requirement: Require held-out Shadow replay
A quality-eligible recipe MUST pass a safe Shadow replay on a held-out task before publication. Training task, run, attempt, and evidence identifiers MUST be excluded from Shadow evidence.

#### Scenario: Shadow replay uses training evidence
- **WHEN** a Shadow result overlaps any source task, run, attempt, or evidence identifier
- **THEN** the replay is invalid and cannot advance the recipe

#### Scenario: Held-out replay passes objective acceptance
- **WHEN** a recipe executes on a held-out safe task and all step, terminal, and safety predicates pass with fresh evidence
- **THEN** the recipe becomes eligible for publication and subsequent A/B exposure
