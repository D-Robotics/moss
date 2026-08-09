## ADDED Requirements

### Requirement: Repository entry is reproducible and verifiable

The repository SHALL provide a tracked root Agent entry that declares the supported Node version, lockfile-faithful setup, focused verification, fast verification, full verification, and the success semantics of each command.

#### Scenario: Fresh clone setup

- **WHEN** a coding agent follows only the root Agent entry from a clean clone
- **THEN** it can install the exact lockfile dependency graph and identify the expected successful outcome without consulting local-only instructions

#### Scenario: Documented command drifts

- **WHEN** a contributor policy document names an npm script that is absent from all workspace manifests
- **THEN** workspace hygiene exits non-zero and identifies the stale command

#### Scenario: Empty focused test selection

- **WHEN** a focused package-test filter matches no tests
- **THEN** the command exits non-zero instead of reporting a successful empty run

### Requirement: Mixed fleet tools fail closed in Plan mode

The system SHALL treat a tool that can execute commands across devices as a device mutation unless side effects are safely resolved from the validated request at the execution boundary.

#### Scenario: Fleet execution requested in Plan mode

- **WHEN** the agent requests `fleet_batch` while the CLI interaction mode is Plan
- **THEN** the approval hook rejects execution before any SSH operation and directs the user to leave Plan mode

#### Scenario: Device metadata accidentally becomes permissive

- **WHEN** any tool classified as `device_mutation` declares `planMode: 'allow'`
- **THEN** the approval boundary still rejects it in Plan mode before invoking the tool implementation

#### Scenario: Safe command in Execute mode

- **WHEN** `fleet_batch exec` receives a non-dangerous command through the normal Execute-mode permission path
- **THEN** it reaches the existing device dispatch logic without a new behavioral restriction

#### Scenario: Dangerous command remains blocked

- **WHEN** `fleet_batch exec` receives a command classified as dangerous
- **THEN** it is rejected before fleet dispatch even after the user has left Plan mode

#### Scenario: Gather path cannot inject shell syntax

- **WHEN** `fleet_batch gather` receives a path containing shell substitution or quotes
- **THEN** the path is represented as one escaped shell token and is not evaluated as command syntax
