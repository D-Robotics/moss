# Unify the runtime plugin drive and observable Web console

## Why

Moss currently has two product assembly paths: the CLI constructs and decorates a `MossAgent` directly, while embedding hosts use `createMossRuntime()`. The plugin host covers reversible contributions but not the full runtime graph, and it previously allowed lifecycle races that made dynamic loading unsafe for long tasks. A Web UI cannot become another source of runtime truth.

## User outcome

A user sees one accurate view of a long-running Moss session: turns, streaming output, tool state, usage, and installed plugins. Installing or unloading a host plugin updates the runtime catalog immediately. Unloading waits for active tool calls before releasing their resources. CLI, Web, and embedding hosts ultimately consume one assembly and one ordered event protocol.

## Scope

This change hardens the existing plugin transaction, adds live tool quiescence and a shared Skill catalog, and introduces a React-free Web-console projection plus Moss-authored shell rendering. It also specifies the larger assembly migration so later phases do not add more parallel boot paths.

## Non-goals

- Pixel-copying DeepSeek Harness UI code or assets.
- Loading arbitrary browser or workspace JavaScript.
- Claiming full Cordis Core, dependency injection, Loader, or HMR compatibility.
- Replacing the CLI assembly in one unsafe rewrite; parity is a gated later task.
