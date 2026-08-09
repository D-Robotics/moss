## ADDED Requirements

### Requirement: Compile objective trace differences into recovery recipes

The system SHALL compile an actionable recovery recipe only from schema-v2 Experience and trusted terminal evidence belonging to the same task and run. The recipe MUST describe applicability, failure signature, parameterized operations, expected evidence, terminal acceptance, safety constraints, and source provenance.

#### Scenario: Failed execution later recovers with new evidence

- **WHEN** a single-Skill task fails and later passes with distinct trusted execution evidence
- **THEN** the system records a recipe whose operations represent the objective difference between the failed and recovered traces and whose provenance references both traces

#### Scenario: Assistant text claims a repair

- **WHEN** prose claims that a task was repaired without matching trusted failed and recovered evidence
- **THEN** the system does not compile an actionable recovery recipe

### Requirement: Sanitize and parameterize recipe operations

The system MUST exclude secrets, host identities, raw stdout, and unbounded shell text from persisted recipes. Reusable values SHALL be represented by allowlisted bindings such as task artifact path, sensor index, width, height, and capture-start marker.

#### Scenario: Recovered command contains environment-specific values

- **WHEN** an eligible trace includes a concrete sensor index, temporary path, or image dimensions
- **THEN** the compiler persists validated placeholders and typed binding rules instead of blindly copying the concrete command

#### Scenario: Operation cannot be safely compiled

- **WHEN** a recovered operation contains an unrecognized executable, unsafe shell construct, secret, or unresolved value
- **THEN** the recipe is rejected with a deterministic unsafe-or-unresolved reason and is not published

### Requirement: Preserve recipe revision lifecycle

Recipe records SHALL be append-only, and a published or rolled-back revision MUST remain immutable when later recoveries arrive. New knowledge MUST create a new candidate revision with independent provenance.

#### Scenario: Recovery arrives after publication

- **WHEN** a new recovery is observed for a recipe whose current revision is published
- **THEN** the published revision remains unchanged and a separate candidate revision is created or the event is retained for a future revision
