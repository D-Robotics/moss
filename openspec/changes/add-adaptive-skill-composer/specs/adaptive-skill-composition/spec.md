## ADDED Requirements

### Requirement: Ordered variable-length skill plans

The system SHALL compose a single ordered `SkillPlan` from the current user task, environment context, and live enabled skill registry. The plan SHALL jointly represent skill membership, cardinality, and order; SHALL contain no duplicate skill identities; and SHALL permit an empty plan when no skill is sufficiently relevant.

#### Scenario: Multi-skill task

- **WHEN** a task requires multiple eligible skills with a dependency order
- **THEN** the system returns all selected skills once in an order satisfying the known hard dependencies

#### Scenario: No-skill task

- **WHEN** no eligible skill meets the configured relevance and confidence criteria
- **THEN** the system returns an empty plan marked as rejected and injects no skill body

### Requirement: Live open-vocabulary registry

The system SHALL compose against the current registry snapshot rather than a fixed build-time skill class list.

#### Scenario: Newly installed skill

- **WHEN** a valid skill is installed and the registry is reloaded
- **THEN** the skill can be retrieved and selected without retraining or changing a fixed output layer

### Requirement: Eligibility and safety constraints

The system MUST exclude disabled or environment-ineligible skills before finalizing a plan, and a predicted plan MUST NOT grant permissions or bypass existing approval policy.

#### Scenario: Board-required skill without a board

- **WHEN** a candidate declares that it requires a connected board and no board is present
- **THEN** the skill is excluded from the final plan and the plan diagnostics record the eligibility reason

### Requirement: Progressive skill disclosure

The system SHALL resolve and inject full skill bodies only after validating the final plan and SHALL preserve the plan order in the injected context.

#### Scenario: Ordered context injection

- **WHEN** a validated plan contains three skills
- **THEN** only those three bodies are loaded and their context sections appear in plan order

### Requirement: Manual load compatibility

The system SHALL retain explicit `load_skill` behavior as a recovery and user-directed mechanism and SHALL avoid duplicate body injection for a skill already active in the plan.

#### Scenario: Loading an active skill

- **WHEN** `load_skill` requests a skill already present in the active plan
- **THEN** the tool reports that the skill is already loaded without returning a second full body
