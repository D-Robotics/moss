#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ErrorCode, MossError } from '../dist/errors.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMossRuntime } from '../dist/runtime/shared-runtime.js';

function testProvider() {
  return {
    id: 'plugin-test',
    displayName: 'Plugin test',
    capabilities: { streaming: false },
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  };
}

async function makeRuntime(root, plugins = [], provider = testProvider()) {
  return createMossRuntime({
    workspaceDir: root,
    dataDir: path.join(root, '.data'),
    enableSelfEvolution: false,
    toolProfile: 'desktop-safe',
    plugins,
    agentConfig: {
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-plugin-runtime-'));
try {
  const cleanup = [];
  const runtime = await makeRuntime(root, [
    {
      id: 'example/reviewer',
      setup(context) {
        context.registerTool({
          name: 'plugin_inspect_fixture',
          description: 'Inspect a deterministic fixture.',
          metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            return 'fixture-ok';
          },
        });
        context.registerSkill({
          name: 'plugin-review',
          stableId: 'plugin-review',
          description: 'Review a fixture through the plugin tool.',
          sourcePath: 'plugin://example/reviewer',
          version: '1.0.0',
          tags: ['review'],
          trigger: ['plugin review'],
          risk: 'low',
          permissions: { workspaceRead: true },
          enabled: true,
          updatedAt: 1,
          body: 'Call plugin_inspect_fixture and cite its result.',
        });
        context.registerExpert({
          id: 'plugin-reviewer',
          displayName: 'Plugin reviewer',
          description: 'Reviews deterministic fixtures.',
          instructions: 'Use only the plugin fixture evidence.',
          scope: 'read-only',
          allowedTools: ['plugin_inspect_fixture'],
        });
        context.addPromptLayer('## Plugin review policy\nUse plugin evidence when requested.');
        context.effect(() => () => cleanup.push('first'), 'first custom effect');
        context.effect(() => async () => cleanup.push('second'), 'second custom effect');
      },
    },
  ]);

  const tool = runtime.agent.tools.get('plugin_inspect_fixture');
  assert.ok(tool, 'plugin tool is visible through the real agent registry');
  assert.equal(
    await tool.execute({}, { workspaceDir: root, sessionKey: 'plugin-test' }),
    'fixture-ok'
  );
  assert.ok(runtime.services.skillRegistry.hasStableId('plugin-review'));
  const prompt = runtime.agent.buildSystemPrompt();
  assert.match(prompt, /Plugin review policy/);
  assert.match(prompt, /plugin-reviewer.*Reviews deterministic fixtures/s);
  assert.doesNotMatch(prompt, /Use only the plugin fixture evidence/);

  const snapshot = runtime.plugins.inspect();
  const plugin = snapshot.plugins.find(({ id }) => id === 'example/reviewer');
  assert.deepEqual(plugin?.tools, ['plugin_inspect_fixture']);
  assert.deepEqual(plugin?.skills, ['plugin-review']);
  assert.deepEqual(plugin?.experts, ['plugin-reviewer']);
  assert.equal(plugin?.promptLayerCount, 1);
  assert.equal(plugin?.effectCount, 6);
  assert.doesNotMatch(JSON.stringify(snapshot), /Plugin review policy|Use only the plugin/);
  assert.doesNotMatch(JSON.stringify(snapshot), /first custom effect|second custom effect/);

  await runtime.plugins.unload('example/reviewer');
  assert.equal(runtime.agent.tools.get('plugin_inspect_fixture'), undefined);
  assert.equal(runtime.services.skillRegistry.hasStableId('plugin-review'), false);
  assert.doesNotMatch(runtime.agent.buildSystemPrompt(), /Plugin review policy|plugin-reviewer/);
  assert.deepEqual(cleanup, ['second', 'first'], 'custom effects dispose in reverse order');
  await runtime.close();

  const atomic = await makeRuntime(root);
  await assert.rejects(
    atomic.plugins.install({
      id: 'broken/plugin',
      setup(context) {
        context.registerTool({
          name: 'metadata_free_plugin_tool',
          description: 'Must never be published.',
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            return 'unsafe';
          },
        });
        context.addPromptLayer('MUST_NOT_LEAK');
      },
    }),
    (error) => error instanceof MossError && error.code === ErrorCode.USER_INPUT_INVALID
  );
  assert.equal(atomic.agent.tools.get('metadata_free_plugin_tool'), undefined);
  assert.doesNotMatch(atomic.agent.buildSystemPrompt(), /MUST_NOT_LEAK/);
  assert.deepEqual(
    atomic.plugins.inspect().plugins.filter(({ id }) => id === 'broken/plugin'),
    []
  );

  await assert.rejects(
    atomic.plugins.install({
      id: 'broken/async-effect',
      setup(context) {
        context.registerTool({
          name: 'rolled_back_plugin_tool',
          description: 'A tool rolled back after effect setup fails.',
          metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            return 'must-not-remain';
          },
        });
        context.effect(async () => {
          throw new Error('sentinel async setup failure');
        }, 'failing async setup');
      },
    }),
    /failed to install plugin broken\/async-effect/
  );
  assert.equal(atomic.agent.tools.get('rolled_back_plugin_tool'), undefined);

  const effectReady = deferred();
  let escapedContext;
  const pendingInstall = atomic.plugins.install({
    id: 'example/atomic',
    setup(context) {
      escapedContext = context;
      context.registerTool({
        name: 'atomic_plugin_tool',
        description: 'Visible only after effect preparation.',
        metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return 'atomic';
        },
      });
      context.effect(() => effectReady.promise, 'token=must-not-be-inspected');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(atomic.agent.tools.get('atomic_plugin_tool'), undefined);
  assert.deepEqual(
    atomic.plugins.inspect().plugins.find(({ id }) => id === 'example/atomic')?.tools,
    []
  );
  effectReady.resolve(() => {});
  await pendingInstall;
  assert.ok(atomic.agent.tools.get('atomic_plugin_tool'));
  assert.throws(() => escapedContext.addPromptLayer('PHANTOM_PROMPT'), /context is sealed/);
  assert.doesNotMatch(JSON.stringify(atomic.plugins.inspect()), /must-not-be-inspected|PHANTOM/);
  await atomic.plugins.unload('example/atomic');
  await atomic.close();

  const closing = await makeRuntime(root);
  const setupGate = deferred();
  const racingInstall = closing.plugins.install({
    id: 'example/closing-race',
    async setup(context) {
      await setupGate.promise;
      context.registerTool({
        name: 'late_plugin_tool',
        description: 'Must not survive host close.',
        metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return 'late';
        },
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closingPromise = closing.close();
  setupGate.resolve();
  await assert.rejects(racingInstall, (error) => error.code === ErrorCode.AGENT_DISPOSED);
  await closingPromise;
  assert.equal(closing.agent.tools.get('late_plugin_tool'), undefined);
  assert.deepEqual(closing.plugins.inspect().plugins, []);

  const longRunning = await makeRuntime(root);
  const toolStarted = deferred();
  const toolFinish = deferred();
  const resourceCleanup = [];
  await longRunning.plugins.install({
    id: 'example/long-running',
    setup(context) {
      context.effect(() => () => resourceCleanup.push('disposed'), 'owned resource');
      context.registerTool({
        name: 'long_running_plugin_tool',
        description: 'A deferred plugin tool used to verify drain ordering.',
        metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          toolStarted.resolve();
          await toolFinish.promise;
          assert.deepEqual(resourceCleanup, [], 'resource remains live while the call is active');
          return 'finished';
        },
      });
    },
  });
  assert.ok(longRunning.toolNames.includes('long_running_plugin_tool'));
  const leasedTool = longRunning.agent.tools.get('long_running_plugin_tool');
  const activeCall = leasedTool.execute({}, { workspaceDir: root, sessionKey: 'long-running' });
  await toolStarted.promise;
  let unloadSettled = false;
  const unload = longRunning.plugins
    .unload('example/long-running')
    .then(() => (unloadSettled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unloadSettled, false, 'unload waits for the active tool lease');
  assert.equal(longRunning.toolNames.includes('long_running_plugin_tool'), false);
  await assert.rejects(
    leasedTool.execute({}, { workspaceDir: root, sessionKey: 'late-call' }),
    (error) => error.code === ErrorCode.AGENT_DISPOSED
  );
  toolFinish.resolve();
  assert.equal(await activeCall, 'finished');
  await unload;
  assert.deepEqual(resourceCleanup, ['disposed']);
  await longRunning.close();

  let executed = 0;
  let responseIndex = 0;
  const loopProvider = {
    id: 'plugin-loop-test',
    displayName: 'Plugin loop test',
    capabilities: { streaming: false },
    async complete() {
      return [
        {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'plugin-call', name: 'plugin_loop_tool', input: {} }],
        },
        {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'skill-call',
              name: 'load_skill',
              input: { name: 'plugin-loop-guidance' },
            },
          ],
        },
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Observed plugin-loop-ok and plugin skill guidance.' }],
        },
      ][responseIndex++];
    },
    async stream() {
      throw new Error('streaming disabled');
    },
  };
  const composed = await makeRuntime(
    root,
    [
      {
        id: 'example/loop',
        setup(context) {
          context.registerTool({
            name: 'plugin_loop_tool',
            description: 'Return deterministic plugin-loop evidence.',
            metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
            inputSchema: { type: 'object', properties: {} },
            async execute() {
              executed++;
              return 'plugin-loop-ok';
            },
          });
          context.registerSkill({
            name: 'plugin-loop-guidance',
            stableId: 'plugin-loop-guidance',
            description: 'Guidance loaded through the shared runtime skill catalog.',
            sourcePath: 'plugin://example/loop',
            version: '1.0.0',
            tags: ['plugin'],
            trigger: ['plugin loop'],
            risk: 'low',
            permissions: { workspaceRead: true },
            enabled: true,
            updatedAt: 1,
            body: 'Use plugin-loop-ok as the deterministic result.',
          });
        },
      },
    ],
    loopProvider
  );
  const loopResult = await composed.agent.chat('plugin-loop', 'Call the plugin tool.');
  assert.match(loopResult.response, /plugin-loop-ok.*plugin skill guidance/);
  assert.equal(executed, 1, 'the real agent loop executes the plugin-owned tool once');
  assert.deepEqual(
    loopResult.toolCalls.map(({ name }) => name),
    ['plugin_loop_tool', 'load_skill']
  );
  assert.match(loopResult.toolResults[1].content, /Use plugin-loop-ok as the deterministic result/);
  await composed.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(
  '[PASS] plugin tools, skills, experts, prompts, rollback, and teardown compose correctly'
);
