## ADDED Requirements

### Requirement: A/B samples prove actual Agent exposure
The system SHALL count a treatment outcome only when a receipt proves that the assigned learned guidance revision was injected into that run's Agent context, and SHALL count a control outcome only when no learned guidance was injected.

#### Scenario: Valid treatment exposure
- **WHEN** assignment, run, patch revision, exposure identifier, and guidance hash match a context-injection receipt
- **THEN** the terminal outcome is counted in the treatment arm

#### Scenario: Empty or missing treatment guidance
- **WHEN** a treatment assignment has no non-empty matching exposure receipt
- **THEN** its outcome is marked invalid/excluded and does not affect either arm

#### Scenario: Contaminated control
- **WHEN** learned patch guidance is present in a control run
- **THEN** the outcome is excluded and the contamination is reported

### Requirement: Real A/B reports effect and guardrails
The system SHALL compare eligible arms using terminal success, corrections, retries, Token usage, duration, tool calls, cost when known, safety failures, and failure classes.

#### Scenario: Credible benefit on real tasks
- **WHEN** both real arms meet the configured sample threshold, treatment has a credible success advantage, and cost/retry/safety guardrails pass
- **THEN** the learned Skill can become active for the matching Skill and environment

#### Scenario: Inconclusive experiment
- **WHEN** samples are insufficient or confidence intervals overlap without a guardrail failure
- **THEN** the patch remains shadow and the report states `inconclusive` rather than claiming improvement

#### Scenario: New treatment failure type
- **WHEN** treatment introduces a failure class absent from control or triggers a safety failure
- **THEN** the report identifies the regression and the configured demotion policy is applied
