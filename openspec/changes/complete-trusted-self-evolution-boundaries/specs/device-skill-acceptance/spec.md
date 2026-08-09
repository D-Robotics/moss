## ADDED Requirements

### Requirement: Priority RDK Skills provide machine acceptance contracts

The system SHALL ship valid `ACCEPTANCE.json` contracts for `rdk-capture-photo`, `rdk-isp-tuning`, `rdk-hardware`, and `rdk-command-manual`, covering only concrete executable workflows.

#### Scenario: Registry loads priority contracts

- **WHEN** the production SkillRegistry scans bundled RDK Skills
- **THEN** all four Skills expose validated acceptance predicates and can be referenced by Plan `expectedAccept`

#### Scenario: Knowledge response has no objective execution

- **WHEN** a knowledge-only answer does not execute a contract workflow
- **THEN** the system does not manufacture a machine pass from natural-language quality

### Requirement: Device contracts fail closed and remain safe

The priority device contracts MUST use objective, bounded predicates and MUST mark safety-sensitive checks so that invalid or dangerous evidence cannot pass.

#### Scenario: Capture artifact is valid

- **WHEN** a capture workflow produces a non-empty decodable image in an allowed temporary path
- **THEN** the capture predicates pass and emit evidence references

#### Scenario: ISP or hardware inspection is read-only

- **WHEN** the default ISP, hardware, or command-manual acceptance workflow runs on the RDK X5
- **THEN** it verifies observable state without persisting configuration or executing destructive commands

#### Scenario: Missing device capability

- **WHEN** the required executable, device node, or artifact is absent
- **THEN** the corresponding predicate returns fail or unknown and never fabricates success
