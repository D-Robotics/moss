#!/usr/bin/env node
/**
 * A deferred tool the model calls before `tool_search` used to come back as
 * "Unknown tool: create_subagent ... Use only registered tool names." The tool
 * is registered and on the same list the model can load; "unknown" sent it
 * hunting for another name instead of loading the group.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';
import { runOneShot } from '../dist/cli/oneshot.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

test('calling a deferred tool before tool_search names the group to load', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-deferred-msg-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('deferred-msg', 'Deferred', [
      { toolCalls: [{ name: 'create_subagent', input: { task: 'look around' } }] },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'deferred-msg',
    workspaceDir: workspace,
    baseSystemPrompt: 'Answer.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    maxAgentTurns: 3,
  });
  registerBuiltinTools(agent);

  const toolEnds = [];
  await runOneShot(agent, 'Start a sub-agent.', {
    outputFormat: 'json',
    stdout: { write() {} },
    cwd: workspace,
    sessionKey: 'deferred-msg-run',
    onAgentEvent(event) {
      if (event.type === 'tool_end') toolEnds.push(event);
    },
  });

  const text = toolEnds.map((event) => String(event.result ?? '')).join('\n');
  assert.match(text, /its "subagent" group is not loaded yet/);
  assert.match(text, /tool_search/);
  assert.doesNotMatch(text, /Unknown tool/);
});
