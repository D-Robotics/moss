import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

test('two Agent turns execute the same readonly MCP query and observe its changed backend state', async () => {
  let requests = 0;
  let completions = 0;
  const observed = [];
  const server = createServer((_req, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: ++requests === 1 ? 'running' : 'completed' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/status`;
  const name = 'mcp__fixture__training_status';
  const agent = new MossAgent({
    workspaceDir: process.cwd(),
    llmProvider: {
      id: 'freshness-fixture',
      capabilities: { streaming: false },
      async complete() {
        return ++completions % 2
          ? {
              stopReason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: `read-${completions}`,
                  name,
                  input: { runId: 'selected-run' },
                },
              ],
            }
          : { stopReason: 'end_turn', content: [{ type: 'text', text: 'checked' }] };
      },
    },
    model: 'fixture',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
    hooks: { onBeforeToolExec: async () => ({ approved: true }) },
  });
  agent.tools.register({
    name,
    description: 'Read current status from the owned fixture',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
    metadata: { sideEffectClass: 'readonly' },
    async execute() {
      const result = await (await fetch(url)).json();
      observed.push(result.status);
      return JSON.stringify(result);
    },
  });
  try {
    await agent.chat('fixture-session', 'Check current status');
    await agent.chat('fixture-session', 'Check the same status again');
    assert.equal(requests, 2);
    assert.deepEqual(observed, ['running', 'completed']);
  } finally {
    await agent.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
