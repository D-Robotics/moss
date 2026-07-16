#!/usr/bin/env node
import assert from 'node:assert/strict';

import { runOneShot } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

function createWriter() {
  let output = '';
  return {
    writer: { write(chunk) { output += chunk; } },
    events() {
      return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

const agent = new MossAgent({
  llmProvider: createMockTranscriptProvider('tool-budget', 'Tool Budget', [
    {
      toolCalls: [
        { name: 'inspect_fixture', input: {} },
        { name: 'write_fix', input: {} },
      ],
    },
    { text: "I still need to write the fix. Let me run the write tool now." },
    { text: "I cannot complete the requested implementation because the tool budget blocked the write." },
  ]),
  sessionStore: new InMemorySessionStore(),
  model: 'tool-budget',
  baseSystemPrompt: 'Implement the requested change and verify it.',
  domainPrompt: false,
  includeAgentBehaviorPrompt: false,
  enableSteering: false,
  maxAgentTurns: 8,
});

let writes = 0;
agent.tools.register({
  name: 'inspect_fixture',
  description: 'Inspect the fixture.',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: {} },
  async execute() { return 'fixture inspected'; },
});
agent.tools.register({
  name: 'write_fix',
  description: 'Write the requested fix.',
  metadata: { sideEffectClass: 'local_write' },
  inputSchema: { type: 'object', properties: {} },
  async execute() { writes += 1; return 'fix written'; },
});

const originalExitCode = process.exitCode;
try {
  process.exitCode = undefined;
  const output = createWriter();
  await runOneShot(agent, "Get today's news, then inspect and write the verified result.", undefined, {
    sessionKey: 'headless-tool-budget-contract',
    outputFormat: 'stream-json',
    stdout: output.writer,
  });

  const events = output.events();
  const blockedTool = events
    .filter((event) => event.type === 'user')
    .flatMap((event) => event.message.content)
    .find((block) => block.tool_use_id?.includes('write_fix'));
  const result = events.find((event) => event.type === 'result');

  assert.equal(writes, 0, 'the over-budget write never executes');
  assert.equal(blockedTool?.is_error, true, 'the rejected tool call is observable as an error');
  assert.equal(result?.is_error, true, 'an incomplete implementation cannot be reported as success');
  assert.match(result?.error ?? result?.result ?? '', /tool budget/i);
  assert.notEqual(process.exitCode, undefined, 'budget-blocked completion exits non-zero');
  console.log('[PASS] headless tool-budget exhaustion fails closed');
} finally {
  process.exitCode = originalExitCode;
}
