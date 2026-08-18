# Orchestration specification

## ADDED Requirements

### Requirement: Durable authoritative execution graph

The runtime SHALL persist every task transition as an ordered graph event guarded by an expected
revision, and SHALL recover an unfinished graph as paused after restart.

#### Scenario: competing local owners

- **WHEN** two runtime instances attempt to advance the same graph
- **THEN** only the holder of the unexpired owner lease may append execution transitions

#### Scenario: damaged final write

- **WHEN** a JSONL file ends with an incomplete event
- **THEN** the valid prefix is preserved, the invalid tail is quarantined, and no completed node is replayed

### Requirement: Dependency and write-safe scheduling

The runtime SHALL schedule only nodes whose dependencies are satisfied and whose normalized write paths
do not overlap another active implementation node.

#### Scenario: failed sibling

- **WHEN** one independent node fails
- **THEN** its dependents are blocked while successful sibling evidence remains available

### Requirement: Isolated implementation

An implementation worker SHALL write only in a retained workspace lease and SHALL return a patch whose
parent targets are unchanged from their captured baseline before merge.

#### Scenario: parent edit races with merge

- **WHEN** a target parent file changes after lease creation
- **THEN** merge stops with `merge_conflict` and does not overwrite the parent file

### Requirement: Evidence-bound completion

The runtime SHALL refuse verified completion when required evidence, merged changes, fresh verification,
or requirement coverage is missing.

#### Scenario: model claims success without proof

- **WHEN** model output says the task is complete but required evidence is absent
- **THEN** strict arbitration returns `blocked` with reason `needs_evidence`

### Requirement: Atomic plugin roles

The plugin host SHALL register and dispose agent roles atomically, and SHALL require explicit host
authorization before accepting an implementer with isolated-write permission.

#### Scenario: unauthorized implementation role

- **WHEN** a plugin contributes an isolated-write implementer without host authorization
- **THEN** plugin activation fails atomically and no staged role remains registered
