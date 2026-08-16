# Runtime plugins for embedding hosts

`createMossRuntime()` accepts host-trusted `MossPlugin` objects. A plugin can
contribute tools, inline skills, read-only sub-agent experts, prompt layers, and
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
  JavaScript from the workspace, and the plugin host is not a sandbox.

Dynamic unload while a plugin tool call is still active is not yet an HMR
contract. Hosts should close or drain agent work before unloading a plugin. A
future quiescence layer will gate new calls, abort/drain active leases, and then
release resources.

## Cordis direction

The lifecycle owner is backed by a private, vendored adaptation of Cordis Fiber
effect semantics. Moss intentionally exposes its own beta plugin API rather than
Cordis Context types. See the
[DeepSeek Harness architecture review](../deepseek-harness-review.md) and the
active OpenSpec change `adopt-cordis-plugin-spine` for the staged full-core,
service/inject, loader, and HMR decision gates.
