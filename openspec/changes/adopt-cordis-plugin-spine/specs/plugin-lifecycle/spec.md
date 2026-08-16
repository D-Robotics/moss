# Plugin lifecycle requirements

## Requirement: host-trusted installation

Only an embedding host may supply executable plugins. Model input, tool results,
skills, and workspace configuration MUST NOT create, install, or elevate a
plugin.

### Scenario: prompt names an unknown plugin

- **WHEN** model or user text names a plugin that the host did not install
- **THEN** no plugin code is loaded and no capability changes

## Requirement: atomic contribution publication

The host MUST validate the complete staged contribution batch before publishing
it. Any setup, validation, adapter, or effect failure MUST leave no contribution
active after rollback.

### Scenario: metadata-free tool

- **WHEN** a plugin stages a tool without trusted side-effect metadata
- **THEN** installation fails with `USER_INPUT_INVALID`
- **AND** none of the plugin's tools, skills, experts, or prompts remain visible

## Requirement: owned awaited teardown

Every contribution MUST belong to exactly one plugin effect scope. Teardown MUST
be reverse-order, awaited, idempotent, and continue after individual disposer
failures.

### Scenario: agent closes with a shared expert registry

- **WHEN** a capability pack installed experts into a host-owned registry
- **AND** the agent closes
- **THEN** only that agent's pack experts are removed
- **AND** a replacement agent can reuse the registry

## Requirement: redacted inspection

The inspector MUST be deterministic and MUST NOT expose prompt bodies, trusted
expert instructions, model routing, budgets, credentials, or plugin config.

### Scenario: inspect an active plugin

- **WHEN** a plugin contributes a tool, skill, expert, and prompt
- **THEN** inspection returns their safe IDs, state, count, owner, and effect labels
- **AND** sensitive bodies are absent

## Requirement: stable compatibility

`CapabilityPack` MUST remain a public compatible API. Plugin lifecycle adoption
MUST NOT silently downgrade its release tag or change existing pack behavior.
