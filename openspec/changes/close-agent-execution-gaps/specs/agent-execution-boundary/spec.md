## ADDED Requirements

### Requirement: Unclassified extensions fail closed

The runtime SHALL NOT infer an unclassified registered tool as readonly from its name. Missing safety metadata SHALL resolve to a reviewable mutation.

#### Scenario: Neutral custom tool in Plan mode

- **WHEN** a registered custom tool omits safety metadata and has an unrecognized name
- **THEN** it is treated as a reviewable mutation and rejected before execution in Plan mode

#### Scenario: Misleading read verb in custom tool name

- **WHEN** a registered custom tool omits safety metadata and uses a name such as `get_and_delete` or `search_and_send`
- **THEN** the read-like verb does not make it readonly and Plan mode rejects it before execution

### Requirement: Approval binds final validated input

The runtime SHALL validate tool input after all input-mutating hooks and SHALL request approval only for that final validated input.

#### Scenario: Global hook creates invalid input

- **WHEN** a global pre-tool hook rewrites a schema-valid string field to a number
- **THEN** execution is blocked before approval and the tool implementation is called zero times

#### Scenario: Registry hook chain preserves normalized input

- **WHEN** multiple registry pre-hooks modify valid input in priority order
- **THEN** each hook receives the previous result and approval plus execution receive the final validated input

#### Scenario: Registry hook creates invalid input

- **WHEN** a registry pre-tool hook returns a modified value that violates the tool schema
- **THEN** execution is blocked before approval and the tool implementation is called zero times

### Requirement: Automatic retries are read-only

The runtime SHALL automatically retry transient tool failures only when the tool explicitly declares a `readonly` side-effect class.

#### Scenario: Side-effecting extension requests transient retry

- **WHEN** a custom tool declares a side-effect class other than `readonly`, sets `transientRetry: true`, and fails transiently
- **THEN** the runtime invokes it exactly once
