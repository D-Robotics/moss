# Moss Architecture

This document defines the stable ownership, dependency, execution, state, and failure boundaries of
Moss. It is an engineering map, not a release snapshot: source, public exports, manifests, tests, and
accepted contracts decide current behavior. Feature inventories and temporary change status belong in
CLI help, generated API reports, OpenSpec, pull requests, or the changelog.

## System context

```text
interactive TUI     one-shot / pipe     ACP client     product host
       │                   │                │               │
       └───────────────────┴────────────────┴───────────────┘
                                   │
                                   ▼
                         @rdk-moss/agent
              agent loop · tools · sessions · providers
              context · skills · memory · MCP · devices
                                   │
                                   ▼
                          @rdk-moss/core
                provider-neutral contracts and prompts

create-moss-app ──scaffolds──▶ a host using the public runtime API
```

Moss is a host-neutral agent runtime with a first-party terminal product. A host may reuse the runtime
without adopting the TUI, configuration files, identity, storage, or approval user experience.

## Ownership

| Owner             | Owns                                                                                                                  | Does not own                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@rdk-moss/core`  | Provider-neutral contracts, prompt policy, host and extension interfaces                                              | CLI, persistence choices, product UI, device connections                    |
| `@rdk-moss/agent` | Agent orchestration, provider adapters, tool execution, context, sessions, skills, memory, MCP, robotics helpers, ACP | A host product's identity, authentication, deployment, or final approval UX |
| Moss CLI/TUI      | Argument parsing, terminal rendering, local config discovery, onboarding, interactive approvals                       | Rules for every embedding host                                              |
| Embedding host    | Product UI, users and tenancy, durable storage, secrets, deployment, device context, stricter policy                  | Reimplementation of the core agent loop                                     |
| `create-moss-app` | A minimal supported scaffold                                                                                          | A second runtime implementation                                             |

The detailed host/runtime split is contractual in
[`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md). Public embedding surfaces are
documented in [`packages/moss-agent/API.md`](./packages/moss-agent/API.md) and
[`packages/moss-agent/EXTENDING.md`](./packages/moss-agent/EXTENDING.md).

## Dependency rules

The intended dependency direction is:

```text
host or CLI → @rdk-moss/agent → @rdk-moss/core
```

- `packages/moss/` must remain usable without CLI, TUI, filesystem, or robotics implementation code.
- `packages/moss-agent/` may depend on core contracts; core must not depend on the agent package.
- CLI modules adapt the runtime for a terminal. Runtime modules must not import terminal rendering or
  interactive input to implement core behavior.
- Product-specific identity, account, UI, and deployment logic belongs in a platform extension or host,
  not in the provider-neutral core.
- Cross-package entry points are public only when exported by package manifests and covered by the API
  contract. Do not deep-import internal source paths from another package.

The executable import boundary is enforced by `npm run check:boundaries`; the public surface is checked
by `npm run api:check` as part of the full gate.

## Runtime execution

The main ownership path is:

```text
host input
  → MossAgent stream/run API
  → load session and assemble scoped context
  → call provider through normalized LLM contracts
  → emit text/reasoning or validate requested tools
  → execute approved tools and append real results
  → continue until a bounded terminal outcome
  → persist/project events and return host-visible evidence
```

Primary source owners:

- `packages/moss-agent/src/core/agent/`: `MossAgent`, run configuration, steering, and orchestration.
- `packages/moss-agent/src/core/loop/`: turn state, context preparation, provider calls, compaction,
  tool batches, completion, and recovery.
- `packages/moss-agent/src/core/tools/`: registration, schema checks, hooks, approvals, execution, and
  result guards.
- `packages/moss-agent/src/provider/`: provider selection and protocol adapters.
- `packages/moss-agent/src/core/session/`: session contracts, event projection, JSONL storage, locks,
  and inbox state.

Streaming events are the integration boundary for progressive host UI. A host should render observed
events and results; it must not infer successful execution from assistant prose.

## Tool safety boundary

A state-changing tool call passes through a layered boundary:

```text
model proposal
  → tool lookup and input schema validation
  → global and registry pre-tool hooks
  → schema revalidation after any hook mutation
  → runtime / host approval decision
  → tool implementation
  → post-tool hooks and result normalization
  → event stream and conversation evidence
```

Important invariants:

- Tool metadata declares the side-effect class; an unknown tool is not assumed read-only.
- Input changed by a hook is revalidated before approval and execution.
- Approval must bind to the final validated tool, input, target, and run context.
- An embedded host that registers state-changing built-ins must provide an approval hook or an equally
  strict outer policy. The root README example fails closed for non-read-only tools.
- Abort signals cross provider, approval, hook, and tool boundaries where supported.
- A tool/provider failure stays a failure. Success requires the real result or a verified post-condition.

The CLI supplies its own policy and approval experience. Host policy may be stricter, but project
configuration cannot silently weaken user-owned safety settings.

## State and persistence

State has an explicit owner and scope:

| State                | Runtime contract                                                | Default / CLI implementation                       | Host option                                                    |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Conversation         | Session store and event contracts                               | JSONL or in-memory stores, depending on entry path | Inject durable, tenant-scoped storage                          |
| Active run           | Run/session identity, abort and steering state                  | Process-local orchestration                        | Project events into a host job system                          |
| Execution graph      | Goal, Delivery Case, DAG, acceptance, review, evidence, verdict | `ExecutionStore` under `.moss/runtime/executions`  | Use `ExecutionQuery`/`ExecutionAction`; never infer completion |
| Context              | Messages, budgets, pruning and compaction checkpoints           | Runtime-managed per run                            | Configure budgets and observe usage                            |
| Skills and knowledge | Registries, loaders, capability packs                           | Bundled/workspace discovery                        | Inject product or domain sources                               |
| Memory               | Scoped memory interfaces and stores                             | CLI/runtime-selected local stores                  | Provide tenant-aware persistence                               |
| Devices              | Device/tool contracts and connection adapters                   | Optional SSH/robotics integrations                 | Host owns credentials and device identity                      |

Never use model-generated text as authoritative state. Persist structured events, tool results, exit
codes, and post-conditions. Stores that share a workspace must preserve session identity and write
exclusion; hosts add account and tenant isolation at their boundary.

Delivery intake is fail-closed: deterministic scope/risk policy selects the minimum depth before a
provider runs, and plugins or model output may only increase it. Delivery Case revisions, elaboration,
requirements, proposals, acceptance verdicts, reviews, and reports are graph events. Proposal and
acceptance revisions invalidate their dependent approvals/verdicts; `CompletionArbiter` remains the
only terminal authority. Host adapters may automate evidence-complete read-only closure, but mutation
closure still requires guarded merge and fresh verifier evidence.

## Configuration and trust precedence

The CLI resolves product defaults, user configuration, explicit project configuration, and supported
runtime overrides according to the source-specific rules in
[`docs/user-guide/05-configuration.md`](./docs/user-guide/05-configuration.md).

- User-owned safety fields override project values; cloning a repository cannot lower the user's trust
  stance.
- `moss setup` encrypts the model key in the user config by default. Explicit project config can also
  contain model credentials, so tracked project config must never include real secrets.
- Embedding hosts should inject credentials through their own secret boundary and avoid exposing them in
  prompts, events, logs, checkpoints, or error messages.
- Provider capability differences are normalized at the adapter boundary rather than scattered through
  host code.

Environment ownership is catalogued in [`docs/env-vars.md`](./docs/env-vars.md). Security-sensitive
changes must also follow [`packages/moss-agent/SECURITY.md`](./packages/moss-agent/SECURITY.md).

## Extension model

Choose one extension owner per capability:

| Need                                                       | Preferred surface                     |
| ---------------------------------------------------------- | ------------------------------------- |
| Stable product identity or prompt context                  | Persona / prompt layer                |
| On-demand domain workflow                                  | Skill or capability pack              |
| Typed local action                                         | Tool plus metadata, schema, and hooks |
| External tool/resource server                              | MCP                                   |
| Model backend                                              | Provider adapter                      |
| Product-owned identity, UI, persistence, or device context | Platform extension / Host Adapter     |

Do not register parallel tools for the same intent merely to expose another transport. Adapt transports
behind one capability owner. New public extension points require exports, documentation, tests, and an
API report update.

## Robotics boundary

Robotics is composed into the general runtime through device tools, adapters, skills, and knowledge. A
connected board is optional: core coding and research behavior must remain usable without device access.

- The host owns device identity, credentials, connection lifecycle, and user consent.
- Read-only telemetry and state-changing device actions remain distinguishable in metadata and policy.
- Board-specific commands require a matching capability/device profile and evidence from the real board.
- Tests that need physical hardware are explicit opt-in gates; skipped hardware evidence must not be
  reported as a pass.

## Failure and recovery

Moss fails closed at security and data-integrity boundaries while keeping recoverable product failures
visible to the host.

- Invalid input, rejected approval, abort, timeout, provider failure, and tool failure remain distinct
  outcomes.
- Retrying is limited to failures classified as transient and safe for the operation.
- Context overflow may trigger pruning or compaction, but cannot discard the active goal or fabricate a
  successful terminal state.
- Background and subagent work reports its own run identity, lifecycle, and final evidence.
- Partial output may be rendered when a run stops, but it is not equivalent to completion.

The shared error conversion boundary is documented in
[`docs/error-boundary-policy.md`](./docs/error-boundary-policy.md).

## Change routing

| Change                                | Start at                                 | Required companion work                                      |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Core contract or dependency direction | `packages/moss/`, package manifests      | Boundary tests, API report, migration note if breaking       |
| Agent loop or tool execution          | `packages/moss-agent/src/core/`          | Focused regression plus full agent tests                     |
| CLI command/config/TUI                | `packages/moss-agent/src/cli/`           | CLI parser/help tests and smoke test                         |
| Embedding surface                     | Public exports, `API.md`, `EXTENDING.md` | Type tests, example/smoke coverage, API check                |
| Host ownership boundary               | Host Adapter contract and extensions     | Contract tests in both runtime and host                      |
| Architecture boundary                 | This file plus source/tests              | `npm run check:boundaries`, `npm run api:check`, full verify |

Repository-specific instructions and focused commands live in [`AGENTS.md`](./AGENTS.md) and package
level `AGENTS.md` files.

## Verification and document lifecycle

Use the executable gates instead of copying result counts into documentation:

```bash
npm run check
npm run verify
npm run smoke:moss-cli
```

- `npm run check` is the fast formatting, lint, type, boundary, hygiene, maintainability, and standards
  gate.
- `npm run verify` adds benchmark, build, API, and package tests.
- `npm run smoke:moss-cli` validates the packed consumer-facing CLI path.

Update this document when an ownership or dependency boundary changes. Put proposals in OpenSpec or a
design note; put time-bound observations under `docs/evidence/` with a source revision; use Git and the
changelog for history. Do not turn this file into a feature matrix, test-count snapshot, or roadmap.
