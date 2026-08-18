#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

function makeAgent(id) {
  return new MossAgent({
    llmProvider: {
      id,
      displayName: id,
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
      async stream() {
        throw new Error('streaming disabled');
      },
    },
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
}

function contributionPlugin(id = 'fixture/composition') {
  return {
    id,
    setup(context) {
      context.registerCommand({
        id: 'fixture-command',
        title: 'Fixture command',
        expand: (args) => `Fixture: ${args}`,
      });
      context.registerProvider({
        id: 'fixture-provider',
        displayName: 'Fixture provider',
        async create() {
          return {
            id: 'fixture-provider-runtime',
            displayName: 'Fixture provider runtime',
            capabilities: { streaming: false },
            async complete() {
              return { stopReason: 'end_turn', content: [] };
            },
            async stream() {
              throw new Error('streaming disabled');
            },
          };
        },
      });
      context.registerMcpPreset({
        id: 'fixture-mcp',
        displayName: 'Fixture MCP',
        server: { command: 'node', args: ['fixture-server.mjs'] },
      });
    },
  };
}

test('command, provider, and MCP contributions are owned, redacted, and instance-local', async () => {
  const first = makeAgent('first-instance');
  const second = makeAgent('second-instance');
  try {
    const before = first.plugins.inspect().generation;
    const handle = await first.plugins.install(contributionPlugin());
    const snapshot = first.plugins.inspect();
    const plugin = snapshot.plugins.find(({ id }) => id === 'fixture/composition');

    assert.equal(snapshot.generation, before + 1);
    assert.deepEqual(plugin?.commands, ['fixture-command']);
    assert.deepEqual(plugin?.providers, ['fixture-provider']);
    assert.deepEqual(plugin?.mcpPresets, ['fixture-mcp']);
    assert.doesNotMatch(JSON.stringify(snapshot), /Fixture command|fixture-server/);
    assert.deepEqual(
      first.plugins.listCommands().map(({ id }) => id),
      ['fixture-command']
    );
    assert.equal(await first.plugins.expandCommand('fixture-command', 'ok'), 'Fixture: ok');
    assert.equal(first.plugins.getProvider('fixture-provider')?.displayName, 'Fixture provider');
    const runtimeProvider = await first.plugins.createProvider('fixture-provider', {});
    assert.equal(runtimeProvider?.id, 'fixture-provider-runtime');
    assert.deepEqual(
      await runtimeProvider?.complete({ model: 'fixture', systemPrompt: '', messages: [] }),
      {
        stopReason: 'end_turn',
        content: [],
      }
    );
    assert.equal(first.plugins.getMcpPreset('fixture-mcp')?.server.command, 'node');
    assert.deepEqual(
      first.plugins.listMcpPresets().map(({ id }) => id),
      ['fixture-mcp']
    );
    let mcpDisposed = false;
    assert.equal(
      await first.plugins.activateMcpPreset('fixture-mcp', async () => ({
        value: 'MCP_ACTIVE',
        dispose: () => {
          mcpDisposed = true;
        },
      })),
      'MCP_ACTIVE'
    );
    assert.equal(second.plugins.getCommand('fixture-command'), undefined);

    await second.plugins.install(contributionPlugin());
    await assert.rejects(
      first.plugins.install(contributionPlugin('fixture/conflict')),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /plugin command already registered: fixture-command/.test(error.cause.message)
    );
    assert.equal(first.plugins.inspect().generation, snapshot.generation);
    assert.equal(first.plugins.getCommand('fixture-command')?.expand('still'), 'Fixture: still');

    await assert.rejects(
      first.plugins.install({
        id: 'fixture/rollback',
        setup(context) {
          context.registerCommand({
            id: 'rollback-command',
            title: 'Rollback command',
            expand: () => 'must disappear',
          });
          context.registerProvider({
            id: 'rollback-provider',
            displayName: 'Rollback provider',
            create: async () => {
              throw new Error('must not be created');
            },
          });
          context.registerMcpPreset({
            id: 'rollback-mcp',
            displayName: 'Rollback MCP',
            server: { command: 'node' },
          });
          context.effect(async () => {
            throw new Error('ROLLBACK_SENTINEL');
          });
        },
      }),
      /failed to install plugin fixture\/rollback/
    );
    assert.equal(first.plugins.inspect().generation, snapshot.generation);
    assert.equal(first.plugins.getCommand('rollback-command'), undefined);
    assert.equal(first.plugins.getProvider('rollback-provider'), undefined);
    assert.equal(first.plugins.getMcpPreset('rollback-mcp'), undefined);

    await handle.dispose();
    assert.equal(mcpDisposed, true);
    assert.equal(first.plugins.inspect().generation, snapshot.generation + 1);
    assert.equal(first.plugins.getCommand('fixture-command'), undefined);
    assert.equal(first.plugins.getProvider('fixture-provider'), undefined);
    assert.equal(first.plugins.getMcpPreset('fixture-mcp'), undefined);
    assert.equal(second.plugins.getCommand('fixture-command')?.expand('ok'), 'Fixture: ok');
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});

test('active plugin tool leases drain before unload and timeout restores the last-good generation', async () => {
  const agent = makeAgent('lease-instance');
  let release;
  let shouldBlock = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await agent.plugins.install({
      id: 'fixture/leased',
      setup(context) {
        context.registerTool({
          name: 'leased_fixture',
          description: 'Hold one plugin call open.',
          metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            if (shouldBlock) await gate;
            return 'LEASED_OK';
          },
        });
      },
    });
    const activeGeneration = agent.plugins.inspect().generation;
    assert.equal(
      agent.plugins.inspect().plugins.find(({ id }) => id === 'fixture/leased')?.callState,
      'accepting'
    );
    const tool = agent.tools.get('leased_fixture');
    assert.ok(tool);
    const activeCall = tool.execute({}, { sessionKey: 'lease', workspaceDir: process.cwd() });

    await assert.rejects(
      agent.plugins.unload('fixture/leased', { timeoutMs: 20 }),
      /did not become quiescent/
    );
    assert.equal(agent.plugins.inspect().generation, activeGeneration);
    assert.equal(
      agent.plugins.inspect().plugins.find(({ id }) => id === 'fixture/leased')?.state,
      'active'
    );
    assert.equal(agent.tools.get('leased_fixture'), tool);

    shouldBlock = false;
    assert.equal(
      await tool.execute({}, { sessionKey: 'lease-after-timeout', workspaceDir: process.cwd() }),
      'LEASED_OK'
    );

    const unloading = agent.plugins.unload('fixture/leased', { timeoutMs: 1_000 });
    assert.equal(
      agent.plugins.inspect().plugins.find(({ id }) => id === 'fixture/leased')?.callState,
      'draining'
    );
    await assert.rejects(
      tool.execute({}, { sessionKey: 'lease-draining', workspaceDir: process.cwd() }),
      /plugin is draining: fixture\/leased/
    );
    release();
    assert.equal(await activeCall, 'LEASED_OK');
    await unloading;
    assert.equal(agent.tools.get('leased_fixture'), undefined);
    assert.equal(agent.plugins.inspect().generation, activeGeneration + 1);
  } finally {
    release?.();
    await agent.close();
  }
});

test('plugin command leases reject new expansion while an earlier expansion drains', async () => {
  const agent = makeAgent('command-lease-instance');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await agent.plugins.install({
      id: 'fixture/leased-command',
      setup(context) {
        context.registerCommand({
          id: 'leased-command',
          title: 'Leased command',
          async expand(args) {
            await gate;
            return `expanded:${args}`;
          },
        });
      },
    });
    const activeCall = agent.plugins.expandCommand('leased-command', 'first');
    const unloading = agent.plugins.unload('fixture/leased-command', { timeoutMs: 1_000 });
    await assert.rejects(
      agent.plugins.expandCommand('leased-command', 'second'),
      /plugin is draining: fixture\/leased-command/
    );
    release();
    assert.equal(await activeCall, 'expanded:first');
    await unloading;
    assert.equal(agent.plugins.getCommand('leased-command'), undefined);
  } finally {
    release?.();
    await agent.close();
  }
});

test('cancelling a loading plugin does not advance the last-good generation', async () => {
  const agent = makeAgent('cancel-loading-instance');
  let releaseSetup;
  const setupGate = new Promise((resolve) => {
    releaseSetup = resolve;
  });
  const before = agent.plugins.inspect().generation;
  const installing = agent.plugins.install({
    id: 'fixture/loading',
    async setup(context) {
      await setupGate;
      context.registerTool({
        name: 'never_activated_fixture',
        description: 'Must not create a composition generation.',
        metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return 'never';
        },
      });
    },
  });
  const closing = agent.close();
  await closing;
  releaseSetup();
  await assert.rejects(installing, /plugin installation was cancelled/);
  assert.equal(agent.plugins.inspect().generation, before);
});
