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
  assert.doesNotMatch(JSON.stringify(snapshot), /Plugin review policy|Use only the plugin/);

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
  await atomic.close();

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
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Observed plugin-loop-ok.' }],
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
        },
      },
    ],
    loopProvider
  );
  const loopResult = await composed.agent.chat('plugin-loop', 'Call the plugin tool.');
  assert.match(loopResult.response, /plugin-loop-ok/);
  assert.equal(executed, 1, 'the real agent loop executes the plugin-owned tool once');
  assert.deepEqual(
    loopResult.toolCalls.map(({ name }) => name),
    ['plugin_loop_tool']
  );
  await composed.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(
  '[PASS] plugin tools, skills, experts, prompts, rollback, and teardown compose correctly'
);
