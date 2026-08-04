## ADDED Requirements

### Requirement: Backward-compatible structured metadata
The registry SHALL accept optional stable identity, summary, input, output, dependency, ordering, and conflict metadata while continuing to load existing `SKILL.md` files that omit every new field.

#### Scenario: Legacy skill file
- **WHEN** a valid existing skill declares only name, description, tags, and triggers
- **THEN** the registry loads it with deterministic defaults and makes it eligible for composition

### Requirement: Stable skill identity
The system SHALL assign each loaded skill a stable identity suitable for plan traces and caches and SHALL keep content version or hash separate from that identity.

#### Scenario: Body-only edit
- **WHEN** a skill body changes without changing its declared stable identity or normalized source/name identity
- **THEN** existing dependency references continue to resolve while the content version changes

### Requirement: Dependency-aware ordering
The composer SHALL treat explicit prerequisite and before/after declarations as hard ordering constraints and MAY use I/O overlap or successful workflow co-occurrence as soft ordering evidence.

#### Scenario: Explicit prerequisite
- **WHEN** skill B declares skill A as a prerequisite and both are selected
- **THEN** skill A appears before skill B in the validated plan

### Requirement: Metadata diagnostics
The registry SHALL diagnose unknown dependency references, self-references, invalid field values, and dependency cycles without making unrelated valid skills unavailable.

#### Scenario: Dependency cycle
- **WHEN** the selected metadata contains a dependency cycle
- **THEN** the system emits a cycle diagnostic and uses a stable fallback order or deterministic fallback plan

### Requirement: Environment-aware metadata
Composition SHALL apply existing and extended runtime policy metadata, including enabled state, board requirements, permissions, and conflicts, before skill bodies are injected.

#### Scenario: Conflicting skills
- **WHEN** two selected candidates declare an unresolved conflict
- **THEN** the final validated plan does not contain both skills and records the resolution

### Requirement: Learned skill metadata participation
Newly learned skills SHALL receive or derive enough compact metadata to enter deterministic retrieval immediately after promotion.

#### Scenario: Promoted learned skill
- **WHEN** the skill-learning pipeline promotes a new `SKILL.md`
- **THEN** registry reload makes its stable identity and compact retrieval metadata available to composition
