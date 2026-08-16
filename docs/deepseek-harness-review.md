# DeepSeek Harness architecture review

This review records what Moss can learn from
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
without replacing Moss's three-package architecture. The source baseline is
upstream commit
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a).

## What the upstream method actually is

DeepSeek Harness builds a runtime as an ordered Cordis plugin tree. Model
adapters, tools, session state, and the agent loop are replaceable registrations;
plugin-owned effects unwind during unload. Profiles and bundles provide ordered
configuration layers, while `--dump-config` exposes the composition that really
boots. These claims are documented in its
[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
and
[app-boot contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/README.md).

Three practices are especially valuable:

1. **Reversible ownership.** A registration belongs to a lifecycle and returns
   cleanup rather than mutating process-global state forever.
2. **Capability seams.** A capability identifies its definition, provider, and
   consumer; callers depend on the seam instead of patching the loop.
3. **Composition tests.** Tests exercise the loader, built artifacts, teardown,
   and observable world state instead of trusting an agent's success prose. See
   the upstream
   [testing guide](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/testing.md).

## Moss decision

Moss will adopt these properties incrementally inside `@rdk-moss/agent` and will
move toward an audited vendored Cordis spine. The first source slice vendors the
effect-ownership kernel with its MIT license and exact review provenance; Cordis
types remain private behind Moss APIs. Full Context/Registry/Reflect vendoring is
a later evidence gate, not a prerequisite for every plugin improvement. Moss will
not split every subsystem into a separately published package, and the dependency
direction remains `create-moss-app → agent → core`.

The first integrated slice is the sub-agent expert seam:

- contributor registration validates the whole batch before publishing it;
- registration returns an idempotent disposer;
- capability packs can declaratively contribute experts;
- the parent prompt exposes only catalog-safe identity and description fields;
- trusted instructions, model routing, and budgets stay hidden from the parent
  catalog and are applied only to the selected child;
- an explicit empty tool allowlist remains empty through the real parent-to-child
  adapter instead of falling back to the scope's default tools.

The second slice adds `MossPluginHost`: host-trusted plugins stage tools, inline
skills, experts, prompt layers, and custom effects; validation completes before
publication; teardown is awaited in reverse order; and inspection exposes only
safe IDs and counts. `createMossRuntime()` installs plugins against the same
instance skill registry used by the Skill Composer.

## Phased follow-up

| Phase | Outcome                                                                                  | Required proof                                                                   |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | Vendored effect ownership plus reversible tool/skill/expert/prompt plugins               | failure rollback, LIFO awaited unload, two-instance isolation                    |
| 2     | A read-only composition inspector for tools, prompts, experts, and source ownership      | deterministic snapshot with secrets and trusted prompts redacted                 |
| 3     | One SkillCatalog provider shared by composer, `load_skill`, CLI, and plugins             | identical discovery/digest and reversible source removal                         |
| 4     | Explicit service definition/provider/consumer seams for replaceable runtime capabilities | provider swap test without agent-loop changes                                    |
| 5     | Full Cordis Core vendoring decision                                                      | dependency/reload spike, upstream-sync gate, race matrix, maintenance comparison |
| 6     | Lifecycle-scoped dynamic loading/HMR, only if demanded by embedding hosts                | unload quiescence, cancellation, signatures, Windows and last-good rollback      |

## Explicit non-goals

- No model-triggered installation or execution of arbitrary workspace plugins.
- No JavaScript expressions in declarative configuration.
- No claim that Node.js `vm` provides a security sandbox. DeepSeek Harness also
  warns that its dynamic code runner is not a security boundary in the
  [runner documentation](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/extensions/cordis-host-runner/README.md).
- No repository-wide rewrite or public API break merely to imitate an upstream
  developer-preview architecture.
- No success claim based only on catalog/schema checks; each slice needs a
  built-artifact runtime test and a post-condition.
