#!/usr/bin/env node
/**
 * OFF vs ON comparison for the plan completion gate (MOSS_PLAN_GATE).
 *
 * NOT a real-world-effect benchmark — uses a MOCK LLM provider that models
 * "the model slacks off": it builds a 5-step plan, approves+starts it,
 * completes only step 1, then emits a plain end_turn claiming done.
 *
 * This proves the MECHANISM DIRECTION (gate on -> premature end_turn rejected +
 * correction injected; gate off -> premature end_turn passes, no correction),
 * not real-world gain (a mock provider is not a real model that decides whether
 * to slack off). Real gain requires a real model + controlled task set + N>=3.
 *
 * Same mock, two runs:
 *  - MOSS_PLAN_GATE=off: premature end_turn should PASS (gate no-op). No
 *    correction injected. Run ends after the slack-off turn.
 *  - MOSS_PLAN_GATE=on (default): premature end_turn should be REJECTED and a
 *    correction injected.
 */
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/index.js';

const modelDef = {
  id: 'plan-gate-ab',
  name: 'plan-gate-ab',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function planIdFromMessages(messages) {
  const m = JSON.stringify(messages).match(/Plan created:\s*(plan-[0-9]+-[a-z0-9]+)/i);
  return m ? m[1] : null;
}

// Mock: slack-off model. 5-step plan, completes step 1, then end_turn claiming
// done with 4/5 unfinished. Returns the SAME turns regardless of gate state —
// the gate decides whether that premature end_turn is rejected.
function makeSlackoffProvider() {
  let turn = 0;
  return {
    id: 'plan-gate-ab',
    capabilities: { streaming: true },
    async complete(options) {
      turn += 1;
      const planId = planIdFromMessages(options.messages ?? []);
      if (turn === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'Making a 5-step plan.' },
            {
              type: 'tool_use',
              id: 'c1',
              name: 'plan',
              input: {
                action: 'create',
                goal: 'g',
                steps: [
                  { description: 's1' },
                  { description: 's2' },
                  { description: 's3' },
                  { description: 's4' },
                  { description: 's5' },
                ],
              },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (turn === 2) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'c2', name: 'plan', input: { action: 'approve', planId } },
            { type: 'tool_use', id: 'c3', name: 'plan', input: { action: 'start', planId } },
            { type: 'text', text: 'starting' },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (turn === 3) {
        // complete step 1 only, then (turn 4) prematurely end_turn.
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'd1',
              name: 'plan_step',
              input: { planId, stepNumber: 1, action: 'complete', actualOutput: 'done s1' },
            },
            { type: 'text', text: 'step1 done' },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      // turn >= 4: SLACK OFF — plain end_turn claiming done with 4/5 unfinished.
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'All done!' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async stream(options, onEvent) {
      const r = await this.complete(options);
      for (const b of r.content) {
        if (b.type === 'text' && b.text) onEvent({ type: 'content_block_delta', text: b.text });
        if (b.type === 'tool_use') onEvent({ type: 'tool_use', ...b });
      }
      onEvent({ type: 'message_stop' });
      return r;
    },
  };
}

async function run(gateFlag) {
  if (gateFlag !== undefined) process.env.MOSS_PLAN_GATE = gateFlag;
  else delete process.env.MOSS_PLAN_GATE;
  const sessionStore = new InMemorySessionStore();
  const agent = new MossAgent({
    llmProvider: makeSlackoffProvider(),
    sessionStore,
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    model: modelDef.id,
  });
  registerBuiltinTools(agent);
  const sessionKey = 'ab-' + (gateFlag === 'off' ? 'off' : 'on');
  let threw = null;
  try {
    await agent.chat(sessionKey, 'do it');
  } catch (e) {
    threw = e;
  }
  const messages = await sessionStore.loadMessages(sessionKey);
  const serialized = JSON.stringify(messages);
  return {
    threw,
    correctionInjected: /remain unfinished|plan has unfinished/i.test(serialized),
    sawPrematureEnd: /All done!|Plan complete/i.test(serialized),
  };
}

// --- OFF: gate disabled -> premature end_turn passes, no correction injected ---
const off = await run('off');
assert.equal(
  off.correctionInjected,
  false,
  'OFF: gate disabled -> no plan-completion correction injected (premature end_turn passed)'
);
assert.ok(
  off.threw === null || /Completion rejected/.test(off.threw?.message ?? ''),
  'OFF: run either ends cleanly or hits a non-plan-gate exhaustion (no plan-gate rejection)'
);

// --- ON (default): gate active -> premature end_turn rejected, correction injected ---
const on = await run(undefined);
assert.equal(
  on.correctionInjected,
  true,
  'ON (default): gate active -> plan-completion correction injected (premature end_turn rejected)'
);

console.log(
  '[PASS] plan-completion-gate ab: off passes / on rejects (mechanism direction verified, not real gain)'
);
console.log(
  '  OFF: correction injected =',
  off.correctionInjected,
  '| threw =',
  off.threw ? off.threw.message : 'none'
);
console.log('  ON:  correction injected =', on.correctionInjected);
