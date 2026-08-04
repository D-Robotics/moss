## ADDED Requirements

### Requirement: Trusted evidence declares an execution domain
The system SHALL record `local`, `simulation`, or `real` on every new Experience, TerminalVerdict, LearningEvent, candidate proof, and experiment outcome, using a value supplied by the trusted runtime rather than inferred from model text.

#### Scenario: Complete real device run
- **WHEN** a tool run uses an identified physical device session with a complete environment fingerprint
- **THEN** its new evidence records `executionDomain=real` and is eligible for real-device evaluation

#### Scenario: Legacy or ambiguous run
- **WHEN** a record has no trusted execution domain or incomplete device identity
- **THEN** it remains readable for audit but cannot become new real-device proof

### Requirement: Simulation success cannot promote a device Skill
The system MUST keep simulation and real confidence separate and MUST require real eligible evidence for publishing or activating a learned device Skill.

#### Scenario: Simulation passes repeatedly
- **WHEN** a device Skill accumulates only passing simulation outcomes
- **THEN** its real proof count remains zero and publication or activation is rejected

#### Scenario: First real evaluation
- **WHEN** a simulation-derived candidate is used on a real device for the first time
- **THEN** its real confidence starts at zero and only that fresh real outcome can change it

#### Scenario: Simulation failure
- **WHEN** a simulation outcome fails with trusted simulated evidence
- **THEN** the system may retain the failure as a reject or diagnostic signal but does not represent it as a real-device failure
