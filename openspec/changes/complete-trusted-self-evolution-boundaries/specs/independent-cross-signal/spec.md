## ADDED Requirements

### Requirement: Cross-signal evidence is sample-linked and auditable

The system SHALL persist append-only cross-signal observations linked to skill, task, run, evidence, environment, channel, source, and verdict.

#### Scenario: Independent channel confirms success

- **WHEN** a primary acceptance pass and a configured independent channel pass refer to the same real task/run/evidence
- **THEN** the sample is eligible to satisfy the cross-signal promotion gate

#### Scenario: Reparsed primary payload

- **WHEN** two checks use the same channel or the same raw observation source
- **THEN** the second check is not considered independent cross-signal confirmation

### Requirement: Promotion fails closed without sufficient cross-signal samples

The system MUST reject automatic promotion when eligible statistical proof lacks linked independent cross-signal confirmation.

#### Scenario: Statistical gate passes alone

- **WHEN** proof count and success rate pass but no eligible independent real signal exists
- **THEN** promotion remains rejected with an auditable cross-signal reason

#### Scenario: Cross-signal environment mismatch

- **WHEN** a cross-signal observation comes from a different or unknown environment fingerprint
- **THEN** it cannot confirm the target real-device sample
