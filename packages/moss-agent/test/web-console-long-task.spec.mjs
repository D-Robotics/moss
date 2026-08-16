#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMossRuntime } from '../dist/runtime/shared-runtime.js';
import { MossWebConsoleProjection, renderMossWebConsoleHtml } from '../dist/web-console/index.js';

const TOOL_TURNS = 24;
let providerTurn = 0;
const provider = {
  id: 'web-console-long-task',
  displayName: 'Web console long task replay',
  capabilities: { streaming: false },
  async complete() {
    if (providerTurn < TOOL_TURNS) {
      const id = `long-call-${providerTurn}`;
      providerTurn++;
      return {
        stopReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 5 },
        content: [{ type: 'tool_use', id, name: 'long_task_step', input: { step: providerTurn } }],
      };
    }
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 8 },
      content: [{ type: 'text', text: 'Long task completed with 24 verified plugin steps.' }],
    };
  },
  async stream() {
    throw new Error('streaming disabled');
  },
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-console-long-'));
try {
  const runtime = await createMossRuntime({
    workspaceDir: root,
    dataDir: path.join(root, '.data'),
    enableSelfEvolution: false,
    toolProfile: 'desktop-safe',
    plugins: [
      {
        id: 'example/long-task',
        setup(context) {
          context.registerTool({
            name: 'long_task_step',
            description: 'Complete one deterministic long-task step.',
            metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
            inputSchema: {
              type: 'object',
              properties: { step: { type: 'number' } },
              required: ['step'],
            },
            async execute(input) {
              return `step-${input.step}-verified`;
            },
          });
        },
      },
    ],
    agentConfig: {
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    },
  });

  const projection = new MossWebConsoleProjection('long-session', runtime.plugins.inspect());
  for await (const event of runtime.agent.streamChat('long-session', 'Complete the long task.', {
    maxTurns: TOOL_TURNS + 2,
    maxToolCalls: TOOL_TURNS,
  })) {
    projection.apply(event, 1_000 + projection.snapshot().updatedAt);
  }

  const snapshot = projection.snapshot();
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.tools.length, TOOL_TURNS);
  assert.ok(snapshot.tools.every(({ status }) => status === 'completed'));
  assert.match(snapshot.text, /24 verified plugin steps/);
  assert.equal(snapshot.plugins.plugins[0].id, 'example/long-task');
  assert.ok(snapshot.inputTokens > 0);
  assert.ok(snapshot.outputTokens > 0);

  const html = renderMossWebConsoleHtml(snapshot);
  assert.match(html, /Moss Console/);
  assert.match(html, /aria-label="Moss sessions"/);
  assert.match(html, /aria-label="Tool trajectory"/);
  assert.match(html, /example\/long-task/);
  assert.match(html, /long-call-23/);
  assert.doesNotMatch(html, /undefined|\[object Object\]/);

  await runtime.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log('[PASS] 24-step real agent run projects into the accessible Moss Web console');
