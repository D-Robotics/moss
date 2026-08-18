# Delivery closure specification

## ADDED Requirements

### Requirement: Risk-adaptive delivery case

The runtime SHALL retain clarification, proposal, approval, execution, verification, and reporting as
events in the authoritative execution graph, and SHALL prevent callers from lowering the minimum depth
selected by risk.

#### Scenario: high-risk request asks for standard depth

- **WHEN** a high-risk case is created with requested depth `standard`
- **THEN** the stored delivery depth is `comprehensive`

### Requirement: Revisioned acceptance contract

Every newly created mutating implementation node SHALL contain at least one non-empty acceptance
criterion, and a criterion change SHALL invalidate verdicts tied to an earlier contract revision.

#### Scenario: acceptance changes after verification

- **WHEN** a verified node receives the next acceptance-contract revision
- **THEN** its old verdict becomes `STALE` and completion requires fresh evidence for the new revision

### Requirement: Independent whole-change review

Non-minimal delivery SHALL require a passing independent read-only whole-change review before the
completion arbiter may verify the graph.

#### Scenario: reviewer finds an integration defect

- **WHEN** a whole-change review returns `FAIL` with blockers and valid fix nodes
- **THEN** the blockers and fix nodes are appended atomically and the case does not complete

### Requirement: Shared product query and action seams

Web, CLI, TUI, ACP, and plugins SHALL observe one execution view and advance it through revision-checked
actions.

#### Scenario: stale browser action

- **WHEN** Web submits an action using an older graph revision
- **THEN** the action fails with a revision conflict and does not partially mutate the graph

### Requirement: Evidence-derived completion report

A completion report SHALL be accepted only after fresh graph verification and SHALL retain requirement
coverage, review identifiers, evidence identifiers, limitations, follow-ups, and measured metrics.

#### Scenario: report before verification

- **WHEN** a host attempts to publish a report before a fresh verified verdict exists
- **THEN** the event is rejected and the delivery stage remains unchanged
