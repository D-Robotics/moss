# Change: adopt a Cordis-derived plugin lifecycle spine

## Why

Moss has several extension shapes—tools, capability packs, skills, platform
extensions, knowledge modules, MCP, and sub-agent experts—but they do not share
ownership, atomic installation, awaited teardown, dependency gating, or a common
composition inspector. This makes “pluggable” mostly a construction-time
convention and creates concrete defects such as leaked pack experts, silent tool
replacement, and different skill catalogs for composition versus `load_skill`.

DeepSeek Harness demonstrates that the useful property is not package count or
dynamic JavaScript configuration; it is a plugin tree where every contribution
is an owned, reversible effect and consumers attach to explicit capability
seams. Moss should move in that direction while preserving its three-package
dependency graph and stable public APIs.

## What changes

- Establish auditable source-vendoring provenance for a narrow Cordis lifecycle
  kernel, retaining the upstream MIT license and exact reviewed revision.
- Introduce a Moss-owned beta plugin API that stages tool, skill, expert, prompt,
  and custom-effect contributions before publishing them.
- Make plugin teardown reverse-order, awaited, idempotent, and part of
  `MossAgent.close()`.
- Add owner-safe tool and inline-skill registration adapters.
- Allow `createMossRuntime()` to install host-trusted plugins before returning,
  with one shared instance-local skill catalog.
- Provide a deterministic inspector that reveals IDs, ownership, state, and
  counts while redacting prompt bodies and trusted expert instructions.
- Preserve `CapabilityPack` as a public compatibility API and lifecycle-own its
  installed experts/tools until agent close.

## Out of scope for this phase

- Full Cordis Context/Registry/Reflect/Events vendoring.
- Cordis Loader, Include, HMR, `!!js`, Node private loader hooks, or arbitrary
  workspace JavaScript discovery.
- Model-triggered plugin installation or permission elevation.
- Treating Node.js `vm`, the plugin host, or declarative metadata as a security
  sandbox.
- Hot-unloading a plugin while its tool has an active call; quiescence and lease
  tracking are required before that becomes supported.
- Replacing the existing LLM, telemetry, event log, or approval implementations.

## Compatibility

`CapabilityPack` remains `@public`; existing packs continue to work. The new
plugin surface is `@beta`. Cordis types remain private implementation details so
Moss can sync or replace the vendored fork without breaking embedding hosts.
