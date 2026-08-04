## Why

Moss must improve multi-skill selection and ordering without giving up its defining ability to run offline and on resource-constrained robotics boards. The current keyword-driven, fixed-cap injection path does not explicitly decide which skills, how many, or in what dependency order, while a mandatory neural router would add unacceptable runtime, memory, packaging, and failure-mode costs for board deployments.

## What Changes

- Introduce a single `SkillComposer` contract that produces an observable, ordered, variable-length `SkillPlan` before agent execution.
- Provide a deterministic, zero-model composer as the default on every platform, combining lexical/trigger retrieval, environment constraints, cardinality/STOP calibration, and dependency-aware ordering.
- Support optional open-vocabulary composer providers, including remote and local-model implementations, without treating the installed skill set as a fixed classifier vocabulary.
- Select a composer through explicit configuration and capability detection; `auto` mode MUST preserve deterministic fallback when a model is unavailable, incompatible, slow, or fails.
- Extend skill metadata with stable identity and dependency/environment declarations while remaining compatible with existing `SKILL.md` files.
- Load only the ordered plan's skill bodies through progressive disclosure, while retaining `load_skill` for manual recovery, newly installed skills, and explicit user requests.
- Add tracing, evaluation, shadow-mode comparison, and rollout gates covering selection, cardinality, ordering, rejection, latency, token cost, and downstream task success.

## Capabilities

### New Capabilities

- `adaptive-skill-composition`: Produces an ordered, variable-length skill plan from the current task, environment, and live skill registry with deterministic fallback.
- `skill-composer-providers`: Defines rules, remote-model, local-model, auto-selection, shadow-mode, timeout, resource-budget, and fallback behavior across host and board deployments.
- `skill-dependency-metadata`: Defines backward-compatible skill identity, dependency, conflict, input/output, and runtime eligibility metadata used during composition.
- `skill-composition-observability`: Defines traces, evaluation metrics, comparison modes, and rollout gates for skill composition quality and runtime cost.

### Modified Capabilities

None. This repository has no existing OpenSpec capability specifications; the change introduces the initial contracts.

## Impact

- Primary code areas: `packages/moss-agent/src/skills`, skill context construction in `src/cli/tui-utils.ts`, one-shot and TUI routing, agent-loop skill reminders, skill-learning metadata, configuration, and observability.
- Existing keyword matching and `load_skill` remain available as compatibility and fallback paths.
- Board deployments remain model-free by default and require no new mandatory native runtime or model artifact.
- Optional local-model support may introduce separately installed inference runtimes and model assets, but these MUST NOT be bundled into the core npm package or required for startup.
- Evaluation expands from explicit `load_skill` calls to the actual composed and injected plan, while continuing to report manual loads separately.
