## ADDED Requirements

### Requirement: Resolve acceptance bindings safely
Acceptance predicates SHALL resolve variables only from an allowlisted typed binding context derived from the current Plan, run, trusted tool results, and environment. Missing, mismatched, or unsafe values MUST return an explicit unknown or fail verdict and MUST NOT be interpreted as shell text.

#### Scenario: Predicate references current artifact path
- **WHEN** an acceptance predicate references `${artifactPath}` and the current run binds it to a normalized allowed path
- **THEN** the predicate evaluates that path and records the resolved value digest in evidence

#### Scenario: Predicate references an unbound variable
- **WHEN** a predicate references a variable absent from the trusted binding context
- **THEN** evaluation returns an unresolved-binding result and does not execute interpolated text

### Requirement: Verify artifact freshness and identity
The acceptance engine SHALL support predicates that prove an artifact was created after a trusted run boundary, is non-empty, and differs from a prohibited or prior digest.

#### Scenario: Stale artifact predates task execution
- **WHEN** an artifact exists but its creation or modification evidence predates the run marker
- **THEN** `file_created_after` or `file_fresh_nonempty` fails

#### Scenario: Reused artifact has the prior digest
- **WHEN** the produced file has the same digest as the artifact recorded before execution
- **THEN** `artifact_digest_changed` fails

### Requirement: Verify image structure and useful content
The acceptance engine SHALL support objective image-dimension and nontrivial-content checks without trusting filename extension or model narration.

#### Scenario: JPEG decodes with expected dimensions
- **WHEN** the artifact decodes as an image with the required width and height and meets the configured content threshold
- **THEN** image acceptance passes and records dimensions and a content metric

#### Scenario: Decodable but poisoned blank frame
- **WHEN** an image decodes but fails the configured entropy or variation threshold
- **THEN** image-content acceptance fails
