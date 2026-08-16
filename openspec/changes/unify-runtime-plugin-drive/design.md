# Design

## Product logic

Moss has three planes. The **execution plane** owns agent runs and tool leases. The **composition plane** owns plugins and capability provenance. The **presentation plane** projects ordered runtime events and sends commands through a host API. Presentation never reads mutable private registries or invents task status.

DeepSeek Harness validates this separation: its Web entry is thin, its UI is composed from plugins, and its long-task views fold an authoritative event window. Moss adopts the method, information architecture, and test discipline, not its component expression or visual assets.

## Runtime assembly target

`MossRuntimeAssembly` becomes the only product bootstrap with `created → starting → ready → draining → closed`. CLI and embedding adapters supply configuration, host-only tools, channels, and presentation, but do not construct registries independently. `MossAgent` remains the loop engine.

Migration order:

1. Harden plugin transaction, public API, tool leases, and live catalog.
2. Convert builtin/extra/capability-pack tool sources into owned plugins.
3. Route CLI and `createMossRuntime()` through one assembly and parity test.
4. Add Skill, Knowledge, hook, completion, observability, and channel contribution kinds.
5. Add provider definition/provider/consumer roles with explicit routing.
6. Add typed presentation slots over an ordered session protocol.
7. Re-evaluate full Cordis Core only after dependency gating and maintenance measurements.

## Plugin transaction

Setup writes into a sealed staging context. Custom effects prepare before any capability is published. Close seals the host against new commits and waits pending installation cleanup. Public inspection exposes fixed counts and identifiers, never prompt bodies, effect labels, credentials, or internal ownership controls.

## Tool quiescence

A scoped tool registration wraps execution in a lease counter. Unload removes discovery first, rejects late calls through stale references, waits active calls, and only then releases the plugin's remaining resources. This gives long-running tools a deterministic drain point without claiming general HMR.

## Shared skills

`ToolContext` receives the runtime's instance-local `SkillRegistry`. `load_skill` consults it before constructing a standalone compatibility registry, so a plugin-contributed Skill can be discovered, loaded, and used in the same real loop.

## Presentation model

The first Web slice is React-free and deterministic. `MossWebConsoleProjection` folds `MossAgentEvent` into stable tool rows, transcript text, turn state, usage, and a redacted plugin inventory. `renderMossWebConsoleHtml()` renders a Moss-branded responsive shell with sidebar, conversation/trajectory center, and capability details. This is an embeddable renderer, not an HTTP command server.

The next protocol phase adds `{ sessionId, seq, emittedAt, event }`, history cursors, resume-after-seq, gap repair, and baseline/live merge before remote control or browser plugin loading.

## Long-task verification

A deterministic provider drives many turns and plugin tool calls without network or hardware. Tests assert ordered event projection, stable row identity, dynamic catalog updates, active-call drain, Skill loading, terminal completion, and complete teardown.
