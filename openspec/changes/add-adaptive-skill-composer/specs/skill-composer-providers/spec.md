## ADDED Requirements

### Requirement: Mandatory deterministic provider

The system SHALL include a model-free deterministic composer that works offline and without optional native inference dependencies or model artifacts.

#### Scenario: Offline board startup

- **WHEN** Moss starts on a board with no network and no model artifact
- **THEN** skill composition remains available through the deterministic provider

### Requirement: Configurable provider modes

The system SHALL support `rules`, `local-model`, `remote-model`, and `auto` composer modes through configuration.

#### Scenario: Explicit rules mode

- **WHEN** composer mode is configured as `rules`
- **THEN** the system does not initialize, download, or invoke a local or remote model provider

### Requirement: Board-safe defaults

The system MUST default a full board deployment to the deterministic provider unless a model provider and resource policy are explicitly enabled.

#### Scenario: Capable board without opt-in

- **WHEN** a board has sufficient compute but local model composition was not explicitly enabled
- **THEN** the system uses the deterministic provider and allocates no composer model resources

### Requirement: Bounded provider execution and fallback

The system SHALL enforce configured latency and resource limits on optional providers and SHALL execute the deterministic provider for the same request when an optional provider times out, fails, produces malformed output, references an unknown skill, or fails plan validation.

#### Scenario: Local model timeout

- **WHEN** a local model exceeds the configured composition deadline
- **THEN** the request receives a validated deterministic plan and records a timeout fallback reason

### Requirement: Open-vocabulary optional providers

Optional model providers MUST select from the candidate metadata supplied for the current request and MUST NOT require all installed skills to be fixed classifier outputs.

#### Scenario: Unseen candidate

- **WHEN** a candidate skill was not present in the provider's training data
- **THEN** the provider can still score or select it from its supplied metadata

### Requirement: Optional artifact isolation

Core Moss installation and startup MUST NOT require downloading or bundling optional composer model artifacts or inference runtimes.

#### Scenario: Core npm installation

- **WHEN** a user installs the standard `@rdk-moss/agent` package
- **THEN** installation succeeds without fetching a composer model or compiling its inference runtime

### Requirement: Shadow mode

The system SHALL support computing a candidate provider plan without allowing that plan to alter injected context or execution.

#### Scenario: Shadow comparison

- **WHEN** shadow mode is enabled with rules as the active provider and a model as the candidate provider
- **THEN** both plans are traced while only the rules plan affects the agent context
