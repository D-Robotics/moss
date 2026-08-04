## ADDED Requirements

### Requirement: Preregister experiment benefit hypotheses
Before eligible outcomes are collected, an experiment MUST freeze one activation hypothesis: success superiority, or success noninferiority plus cost superiority. It SHALL freeze sample targets, noninferiority margin, cost metrics, effect thresholds, safety guardrails, and contamination rules.

#### Scenario: Experiment configuration changes after outcomes
- **WHEN** a configuration or hypothesis is modified after the first eligible outcome
- **THEN** the existing experiment is invalidated or retained under its original frozen configuration and the change receives a new experiment identity

### Requirement: Decide activation from exposed uncontaminated outcomes
Only outcomes with exact treatment receipt, trusted terminal evidence, unique task/run identities, known environment, and matching recipe revision SHALL enter the primary analysis. Activation MUST satisfy the preregistered statistical and practical-effect rule and all safety guardrails.

#### Scenario: Success is noninferior and costs improve
- **WHEN** the treatment success lower bound remains within the frozen noninferiority margin and the selected cost metrics improve beyond their frozen confidence and practical-effect thresholds
- **THEN** the decision may be `active` if no safety, contamination, or new-failure guardrail is violated

#### Scenario: Both arms succeed but treatment costs more
- **WHEN** both arms meet the sample target and treatment has no qualifying success or cost benefit
- **THEN** the recipe remains Shadow with an ineffectiveness reason rather than being activated

### Requirement: Prove usefulness on a held-out real-board scenario
The operational proof SHALL run a balanced default target of 20 eligible Control and 20 eligible Treatment tasks on RDK X5 using held-out tasks and a safe recoverable camera output-path-collision scenario. The report MUST disclose exclusions, exposure receipts, terminal evidence coverage, safety failures, new failure classes, success, retries, tool calls, duration, and token cost.

#### Scenario: Real-board treatment demonstrably improves execution
- **WHEN** 20 eligible outcomes per arm complete without contamination, the learned recipe is actually exposed, objective terminal acceptance is complete, and the preregistered hypothesis passes
- **THEN** the recipe may be activated and the mechanism is reported as empirically useful for the bounded scenario

#### Scenario: Threshold is not met
- **WHEN** the real-board experiment is inconclusive, unsafe, contaminated, or fails the benefit threshold
- **THEN** the recipe remains Shadow and the system reports the exact failed gate without claiming self-improvement
