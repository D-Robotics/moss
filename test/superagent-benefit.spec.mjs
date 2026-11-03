import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBenefit } from '../scripts/bench-superagent-benefit.mjs';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

test('the shared hard 16-turn budget binds both CLI nominal turn ceilings', async () => {
  for (const maxAgentTurns of [16, 24]) {
    let calls = 0;
    const provider = {
      id: 'offline-budget-proof',
      displayName: 'offline',
      capabilities: { streaming: false },
      async complete() {
        calls++;
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: `call-${calls}`, name: 'tick', input: { n: calls } }],
        };
      },
    };
    const agent = new MossAgent({
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      baseSystemPrompt: 'offline boundary check',
      domainPrompt: false,
      enableSteering: false,
      enableFollowUpGuard: false,
      maxAgentTurns,
      budget: { maxTurns: 16 },
    });
    try {
      agent.tools.register({
        name: 'tick',
        description: 'tick',
        metadata: { sideEffectClass: 'readonly' },
        inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
        async execute() {
          return 'ok';
        },
      });
      const result = await agent.chat('budget-proof', 'tick repeatedly');
      assert.equal(calls, 16);
      assert.equal(result.stopReason, 'budget_turns_reached');
    } finally {
      await agent.close();
    }
  }
});

const arm = (acceptedCases, requests, integration = acceptedCases === 3) => ({
  acceptedCases,
  requests,
  integration,
  usageMissing: 0,
  knownInputTokens: 10,
  knownOutputTokens: 5,
});
const pair = (baseline, superagent) => ({ valid: true, baseline, superagent });
test('benefit judgement requires three valid pairs and does not reward cheap failures', () => {
  assert.equal(judgeBenefit([]).verdict, 'incomplete');
  assert.equal(
    judgeBenefit(Array(3).fill(pair(arm(3, 30), arm(0, 1)))).verdict,
    'benefit not demonstrated'
  );
  assert.equal(
    judgeBenefit([
      pair(arm(0, 30), arm(1, 30)),
      pair(arm(1, 30), arm(2, 30)),
      pair(arm(0, 30), arm(0, 30)),
    ]).businessGain,
    true
  );
  assert.equal(
    judgeBenefit(Array(3).fill(pair(arm(3, 30), arm(3, 24)))).requestEfficiencyGain,
    true
  );
  assert.equal(
    judgeBenefit(Array(3).fill(pair(arm(3, 30), arm(3, 25)))).requestEfficiencyGain,
    false
  );
  assert.equal(
    judgeBenefit([
      pair(arm(0, 30), arm(3, 30)),
      pair(arm(0, 30), arm(0, 30)),
      pair(arm(0, 30), arm(0, 30)),
    ]).businessGain,
    false
  );
  assert.equal(
    judgeBenefit([{ valid: false }, ...Array(2).fill(pair(arm(3, 30), arm(3, 20)))]).verdict,
    'incomplete'
  );
});
