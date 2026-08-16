# Design

## Decision 1: vendor provenance first, not an untracked fork

The first source slice is an adaptation of Cordis Fiber effect ownership under
`packages/moss-agent/src/vendor/cordis`. It carries the upstream MIT license,
reviewed Harness commit, local-difference log, and sync rule. It is explicitly
not labeled “Cordis Core”: the complete Context/Registry/Reflect closure is
roughly 3,200 lines including Cosmokit and requires a separate audit.

Full core vendoring is a later decision gate. Before it, the spike must prove a
provider swap, dependency-pending activation, update rollback, and measurable
maintenance value beyond the smaller Moss facade.

## Decision 2: Moss API outside, Cordis lifecycle inside

Public plugins implement `MossPlugin` and receive `MossPluginContext`. The
context exposes only owned contributions:

- `registerTool`
- `registerSkill`
- `registerExpert`
- `addPromptLayer`
- `effect`

The context never exposes Cordis Proxy objects, arbitrary service strings, or
the underlying effect scope. Plugins are host-trusted code. Model and workspace
content cannot construct or load them.

## Decision 3: prepare, validate, commit

Plugin `setup()` initially writes into a private staging record. Before commit,
the host validates:

- plugin and contribution identifiers;
- duplicates within one plugin;
- conflicts with the live instance registries;
- mandatory tool side-effect metadata;
- non-empty prompt layers;
- availability of an instance skill registry.

Only a validated batch is published. Adapter and effect setup failures trigger
reverse rollback. This prevents a failed plugin from remaining partially active,
although trusted plugin code that performs side effects outside `context.effect`
cannot be made transactional.

## Decision 4: exact ownership, no name-only teardown

Plugin tool disposal removes the tool only when the registry still holds the
same object installed by that owner. Inline skills and experts use the same
identity/token discipline. Existing compatibility `register()` methods retain
their behavior for now; plugin installation uses stricter scoped methods.

`CapabilityPack` contributions are adopted by a compatibility root scope.
Closing the agent unloads that scope, including contributions installed into a
host-owned expert registry.

## Decision 5: lifecycle and failure contract

States are `loading → active → unloading → disposed`, with `failed` during an
installation failure. Disposers execute in strict reverse order; all remaining
disposers run even if one fails. Repeated `dispose`/`close` joins the original
promise. Public errors are `MossError` and preserve the native cause.

Agent close first aborts/drains active agent work, then closes plugins, then
releases owned registries. Dynamic unload of a tool with active calls remains
unsupported until a lease/quiescence layer exists.

## Decision 6: one skill catalog per composed runtime

`createMossRuntime()` passes its `SkillRegistry` into `MossAgent`. Plugin inline
skills therefore enter the same catalog used by skill composition. The next
phase must also route `load_skill` through this injected catalog; until then,
plugins should use runtime composition rather than assuming every standalone
CLI tool context sees host-only skills.

Skill metadata describes requested permissions; it never grants tools. Tool
availability and approval continue to derive from trusted tool metadata and host
policy.

## Decision 7: redacted deterministic inspection

Inspection returns sorted plugin IDs and contribution IDs, lifecycle state,
prompt-layer counts, and effect labels. It never returns prompt content, expert
instructions, model routing, budgets, credentials, or arbitrary configuration.

## Decision 8: staged migration

1. **Lifecycle kernel and host facade** — this change.
2. **CapabilityPack adapter and owner tokens** — finish migrating compatibility
   paths without changing behavior.
3. **Unified SkillCatalog service** — composer, `load_skill`, CLI catalog, and
   plugins share one provider.
4. **Service definition/provider/consumer seams** — start with sub-agent spawn
   and skill composer, prove provider replacement without loop edits.
5. **Full Cordis Core vendoring gate** — only after lifecycle race tests,
   provenance automation, and a maintenance comparison.
6. **Controlled declarative loader** — host allowlist plus data-only JSON/YAML;
   no JavaScript expressions or model installation.
7. **HMR** — only after active-call quiescence, watcher drain, Windows path and
   file-lock tests, signature/source policy, and rollback to last-good state.

## Risks

- A partial Cordis adaptation could drift from upstream lifecycle fixes.
  Provenance, focused race tests, and the full-core decision gate mitigate this.
- Dynamic unload can race active tool calls. It is explicitly unsupported in
  this phase; agent close drains runs first.
- Public Cordis types would create vendor lock-in. They remain internal.
- Plugin JavaScript expands the trusted computing base. Only embedding hosts may
  supply plugins, and no automatic filesystem loader is added.
- Skill catalogs still have legacy construction sites. The shared runtime is
  unified first; standalone CLI paths migrate in the next phase.

## Rollback

Remove `plugins` from `createMossRuntime` and the `MossPluginHost` adapter while
retaining existing ToolRegistry/CapabilityPack paths. No persisted data format,
session log, or core contract depends on the new host.
