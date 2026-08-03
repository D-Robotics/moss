## ADDED Requirements

### Requirement: Multi-Skill proof requires unique step ownership
The system SHALL attribute a failure or recovery to a Skill only when fresh evidence maps to exactly one Plan step and that step has exactly one acceptance-contract Skill owner.

#### Scenario: Unique failed step owner
- **WHEN** a multi-Skill Plan fails and the failed predicate plus evidence map to one step owned by one Skill
- **THEN** the system records `single-owner-step` attribution for that Skill and the involved step and evidence identifiers

#### Scenario: Shared or ambiguous step
- **WHEN** the relevant step references multiple Skills or evidence maps to multiple steps
- **THEN** the system records task-level multi-Skill attribution and gives no Skill additional proof

### Requirement: Whole-task success is not distributed across Skills
The system MUST NOT grant each Skill proof merely because a multi-Skill Plan has a passing terminal verdict.

#### Scenario: Multi-Skill task passes without prior attributed failure
- **WHEN** a Plan involving multiple Skills reaches terminal pass
- **THEN** the result is retained for task audit but no individual Skill proof count increases

#### Scenario: Attributed recovery in multi-Skill task
- **WHEN** a uniquely owned failed step is retried with fresh evidence and the task then passes
- **THEN** only the uniquely owned Skill receives the recovery linkage and eligible proof
