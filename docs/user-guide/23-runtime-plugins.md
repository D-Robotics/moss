# Runtime plugins for embedding hosts

`createMossRuntime()` accepts host-trusted `MossPlugin` objects. A plugin can
contribute tools, inline skills, read-only sub-agent experts, prompt layers, Web UI slots, and
owned cleanup effects without mutating process-global registries.

```ts
import { createMossRuntime } from '@rdk-moss/agent/runtime';
import type { MossPlugin } from '@rdk-moss/agent/runtime';

const reviewPlugin: MossPlugin = {
  id: 'example/review',
  setup(ctx) {
    ctx.registerTool({
      name: 'review_fixture',
      description: 'Read and summarize the host fixture.',
      metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return 'host-owned evidence';
      },
    });
    ctx.registerExpert({
      id: 'fixture-reviewer',
      displayName: 'Fixture reviewer',
      description: 'Reviews the host fixture.',
      instructions: 'Use only evidence returned by review_fixture.',
      scope: 'read-only',
      allowedTools: ['review_fixture'],
    });
    ctx.addPromptLayer('Use fixture-reviewer for fixture review requests.');
  },
};

const runtime = await createMossRuntime({
  // workspaceDir, dataDir, agentConfig, ...
  plugins: [reviewPlugin],
});

console.log(runtime.plugins.inspect());
await runtime.plugins.unload('example/review');
await runtime.close();
```

## Explicit CLI installation

Trusted plugins can also ship a `moss.plugin.json` v1 at their package root:

```json
{
  "schemaVersion": 1,
  "id": "example/review",
  "version": "1.0.0",
  "runtime": { "module": "./dist/plugin.js", "export": "plugin" },
  "web": {
    "contributions": [
      { "id": "review-settings", "slot": "settings.plugin", "module": "./dist/settings.js" }
    ]
  },
  "configSchema": "./config.schema.json"
}
```

Install and inspect it explicitly:

```bash
moss plugins add ./my-plugin
moss plugins add @example/moss-review@1.0.0
moss plugins add official:deepseek-harness
moss plugins list
moss plugins doctor
moss plugins enable deepseek/harness
moss plugins disable example/review
```

New plugins are installed **disabled** so installation cannot silently activate executable code.
Local paths remain linked to their resolved root. npm sources require an exact semantic version,
install under the Moss config directory, and run with lifecycle scripts disabled. `doctor` performs
containment, manifest, schema, module-resolution, and compatibility checks without executing a
disabled plugin. `enable` performs candidate activation inside the bounded Worker/RPC lifecycle
before publishing the state change. Registry mutations use a cross-process lock so simultaneous
CLI/Web updates do not lose records. Manifest/runtime failures are reported and isolated so the core
workbench can still start. Web enable, disable, and remove drain active calls and publish a new
composition generation without restarting the server; a failed candidate or drain timeout keeps the
last-good generation active.

`official:deepseek-harness` is an MIT-licensed compatibility Skill adapted from the independently
maintained `HenryZ838978/deepseek-harness` project. It adds protocol guidance for DeepSeek reasoning,
streamed parallel tools, token limits, cache stability, and endpoint selection; it does not install
credentials or claim that third-party JavaScript is sandboxed.

## Fastest path: generate a validated tool

Use the scaffold when starting a new host project:

```bash
npx create-moss-app my-tool-agent --template plugin-tool
cd my-tool-agent
npm run validate-tool
```

The generated validation does not treat registration as success. It checks the
live runtime inventory, asks the configured model to call the tool, verifies the
recorded `toolCalls`, and asserts that the final answer contains the tool's
observed fixture. Provider credentials remain environment variables in the
generated host and must not be committed.

## Lifecycle contract

- `setup()` stages contributions; the complete batch is validated before it is
  published.
- Plugin tools must declare trusted side-effect metadata. Missing metadata or a
  duplicate live ID fails closed.
- Plugin-owned effects and contributions are disposed in reverse order and are
  awaited by `runtime.close()` / `agent.close()`.
- Inspection returns safe IDs, lifecycle states, effect labels, and counts. It
  does not return prompt content, expert instructions, model routing, budgets,
  credentials, or arbitrary plugin configuration.
- Executable plugins are trusted host code. Moss does not discover or execute
  JavaScript automatically from the workspace, and the plugin host is not a sandbox.
- Web contributions use stable Moss slots and package-relative modules. Plugin UI must consume the
  public `--moss-*` tokens. Advanced modules export `mount(root, context)` and receive an isolated
  `ShadowRoot`; JSON Schema configuration remains the preferred default surface.
- A Web contribution must currently be one browser-ready ESM file. Bundle relative and bare imports
  into that file before publishing; the v1 loopback host does not serve multi-file module graphs.

Dynamic unload gates new calls and waits for active Tool/provider/command leases. A timeout keeps the
old generation active; successful Web enable/disable publishes a composition event and browser asset
URLs carry that generation for cache busting. Installed JavaScript import/setup and later calls run
through a termination-bounded Worker/RPC boundary. This prevents sync/async startup hangs from
blocking the core host, but it is not a permission sandbox and installed code remains user-authorized
trusted code.

## Cordis direction

The lifecycle owner is backed by a private, vendored adaptation of Cordis Fiber
effect semantics. Moss intentionally exposes its own beta plugin API rather than
Cordis Context types. See the
[DeepSeek Harness architecture review](../deepseek-harness-review.md) and the
active OpenSpec change `adopt-cordis-plugin-spine` for the staged full-core,
service/inject, loader, and HMR decision gates.
