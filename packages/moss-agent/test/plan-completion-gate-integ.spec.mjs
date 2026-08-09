#!/usr/bin/env node
/**
 * Integration test: the plan completion gate rejects premature end_turn when
 * an approved/executing plan has unfinished steps, the loop continues, and
 * after the model skip-completes each remaining step (one per turn, matching
 * real tool semantics — skipStep only acts on an in_progress step), the gate
 * lets the run end.
 *
 * Drives a real MossAgent loop end-to-end with a mock LLM provider whose
 * per-turn output is controlled by a turn counter. NOT a unit test of the
 * pure evaluatePlanCompletionGate function (that's plan-completion-gate.spec.mjs).
 *
 * Scenario (verify reject -> skip -> pass):
 *  Turn 1: `plan action=create` (2 steps).                  -> plan=draft, planId in history.
 *  Turn 2: `plan action=approve` + `plan action=start` (planId from turn 1).
 *           -> plan=executing, step 1 in_progress. (tool_use turn, no gate.)
 *  Turn 3: plain `end_turn` text "Done." with NO tool_use. -> 0/2 done ->
 *           gate REJECTS -> correction injected -> loop continues.
 *           (The gate only fires on end_turn with no pending tool calls.)
 *  Turn 4: `plan_step action=skip` step 1.                 -> 1/2 (step1 skipped, step2 in_progress)
 *  Turn 5: `plan_step action=skip` step 2.                  -> 2/2 -> gate PASSES.
 *  Turn 6: plain `end_turn` "All handled." -> run ends.
 *
 * NOTE on tool semantics: `skipStep` advances the plan's current step, so
 * step N must be skipped before step N+1 is in_progress. Sending both skips
 * in one turn makes the second fail (its step isn't in_progress yet) — hence
 * one skip per turn. (This mirrors real model behavior: skip is sequential.)
 *
 * NOTE on gate trigger: `completionGate` fires only on `end_turn` with no
 * pending tool_use in the turn (agent-loop-response.ts:276). A turn that emits
 * tool_use is an executing turn — the loop continues without consulting the
 * gate. So the premature-completion claim MUST be a plain end_turn turn.
 *
 * The gate (moss-agent.ts:1500) is installed by default on MossAgent.
 */
import assert from 'node:assert/strict';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/index.js';

const modelDef = {
  id: 'plan-gate-model',
  name: 'plan-gate-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

// Parse the created planId from the conversation history (turn 1's tool_result
// contains "Plan created: <id>").
function planIdFromMessages(messages) {
  const m = JSON.stringify(messages).match(/Plan created:\s*(plan-[0-9]+-[a-z0-9]+)/i);
  return m ? m[1] : null;
}

let turn = 0;
const provider = {
  id: 'plan-gate-integ',
  capabilities: { streaming: true },
  async complete(options) {
    turn += 1;
    const planId = planIdFromMessages(options.messages ?? []);

    if (turn === 1) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Making a 2-step plan.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'plan',
            input: {
              action: 'create',
              goal: 'do the thing',
              steps: [{ description: 'step one' }, { description: 'step two' }],
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (turn === 2) {
      // approve + start (using planId from turn 1's tool_result). This is a
      // tool_use turn — the loop continues; the gate is NOT consulted here.
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c2', name: 'plan', input: { action: 'approve', planId } },
          { type: 'tool_use', id: 'c3', name: 'plan', input: { action: 'start', planId } },
          { type: 'text', text: 'Starting execution.' },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (turn === 3) {
      // Premature completion: a plain end_turn with NO tool_use and the plan
      // still executing with 0/2 steps done. This is the ONLY turn shape that
      // triggers the completion gate.
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Plan complete. Done.' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (turn === 4) {
      // (After the gate rejected and injected a correction:) skip step 1.
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 's1',
            name: 'plan_step',
            input: { planId, stepNumber: 1, action: 'skip', reason: 'not needed' },
          },
          { type: 'text', text: 'Skipping step 1.' },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (turn === 5) {
      // skip step 2 — now 2/2, plan should be complete.
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 's2',
            name: 'plan_step',
            input: { planId, stepNumber: 2, action: 'skip', reason: 'not needed' },
          },
          { type: 'text', text: 'Skipping step 2.' },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    // turn >= 6: both steps skipped, plan complete — emit a plain end_turn.
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'All steps handled.' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async stream(options, onEvent) {
    const result = await this.complete(options);
    for (const block of result.content) {
      if (block.type === 'text' && block.text)
        onEvent({ type: 'content_block_delta', text: block.text });
      if (block.type === 'tool_use') onEvent({ type: 'tool_use', ...block });
    }
    onEvent({ type: 'message_stop' });
    return result;
  },
};

const sessionStore = new InMemorySessionStore();
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore,
  baseSystemPrompt: 'test',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  model: modelDef.id,
});
registerBuiltinTools(agent);

const sessionKey = 'plan-gate-integ-1';

let chatThrew = null;
try {
  await agent.chat(sessionKey, 'Make a 2-step plan and complete it.');
} catch (err) {
  chatThrew = err;
}

const messages = await sessionStore.loadMessages(sessionKey);
const serialized = JSON.stringify(messages);

// The gate must have rejected the premature end_turn on turn 2 and injected its
// correction (it lists unfinished steps / tells the model to skip them).
const correctionMatch = serialized.match(/remain unfinished|plan_step action="skip"/i);
assert.ok(
  correctionMatch,
  'the plan-completion gate injected a correction (premature end_turn was rejected)'
);

// Both steps must have been skipped (escape hatch exercised) — search for the
// successful skip tool_results (not the error variant).
const skips = serialized.match(/Step \d+ skipped:/gi) || [];
assert.ok(
  skips.length >= 2,
  `both plan steps were skipped after the rejection (found ${skips.length} successful skips)`
);

// The run must NOT have crashed with the retry-exhaustion throw — when the
// model does the right thing (skip each step), the gate converges and the run
// ends cleanly. (The throw path is a separate, documented behavior.)
assert.equal(chatThrew, null, 'chat did not throw — gate converged after skips');

console.log('[PASS] plan-completion-gate integration: reject -> skip -> pass');
