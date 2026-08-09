## ADDED Requirements

### Requirement: Lifecycle decisions accept only boundary-qualified evidence

The self-evolution lifecycle SHALL include evidence in candidate publication, promotion, experiment activation, and rollback decisions only when it meets the execution-domain, attribution, environment, freshness, cross-signal, and exposure requirements applicable to that decision.

#### Scenario: Mixed eligible and ineligible history

- **WHEN** a Skill has legacy, simulated, ambiguous multi-Skill, unexposed A/B, and qualified real records
- **THEN** decision statistics include only the qualified real records while reports retain excluded counts and reasons for audit

#### Scenario: No qualified evidence remains

- **WHEN** all available records are excluded by the boundary rules
- **THEN** the learned artifact cannot publish or activate and the lifecycle remains proposed or shadow
