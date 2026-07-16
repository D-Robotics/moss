#!/usr/bin/env node
/**
 * Regression test for the autonomous loop: verifies that LoopScheduler
 * stops when the model signals completion (DONE), and continues when it
 * says CONTINUE with a next-step prompt.
 */
import assert from 'node:assert/strict';

import { LoopScheduler } from '../dist/core/loop/loop-scheduler.js';

// ─── Mock agent + provider ─────────────────────────────────────────────────────
// The autonomous loop calls agent.chat() for each iteration and
// provider.complete() for the completion check. We control both so we can
// deterministically test the DONE / CONTINUE branching.

function createMockAgent({ chatResponses, completionResponses }) {
  let chatIndex = 0;
  let completionIndex = 0;
  const chatLog = [];

  const provider = {
    async complete({ messages }) {
      const idx = completionIndex++;
      const resp = completionResponses[Math.min(idx, completionResponses.length - 1)];
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: resp }],
      };
    },
  };

  const agent = {
    config: {
      model: 'test-model',
      llmProvider: provider,
      sessionStore: {
        async loadMessages() { return []; },
        async appendMessage() {},
        async replaceMessages() {},
      },
    },
    async chat(sessionKey, prompt) {
      chatLog.push(prompt);
      const idx = chatIndex++;
      const resp = chatResponses[Math.min(idx, chatResponses.length - 1)];
      return { response: resp, toolCalls: [], toolResults: [], stopReason: 'end_turn' };
    },
    _chatLog: chatLog,
  };

  return agent;
}

// ─── Test 1: Loop stops when model says DONE ──────────────────────────────────
{
  const agent = createMockAgent({
    chatResponses: ['Fixed the bug in parser.ts'],
    completionResponses: ['DONE'],
  });

  const events = [];
  const sched = new LoopScheduler(agent, {
    prompt: 'Fix the parser bug',
    intervalMs: 0,
    maxIterations: 10,
    sessionKey: 'test-loop-done',
    journal: false,
    autonomous: true,
  });
  sched.on((e) => events.push(e));

  await sched.start();

  const completed = events.find((e) => e.type === 'loop_completed');
  assert.ok(completed, 'should emit loop_completed when model says DONE');
  assert.equal(completed.totalIterations, 1, 'should stop after 1 iteration');
  console.log('✓ autonomous loop stops on DONE after 1 iteration');
}

// ─── Test 2: Loop continues when model says CONTINUE, then stops on DONE ──────
{
  const agent = createMockAgent({
    chatResponses: [
      'Fixed the parser bug',
      'Added a regression test',
    ],
    completionResponses: [
      'CONTINUE: add a regression test for the parser bug',
      'DONE',
    ],
  });

  const events = [];
  const sched = new LoopScheduler(agent, {
    prompt: 'Fix the parser bug and add a test',
    intervalMs: 0,
    maxIterations: 10,
    sessionKey: 'test-loop-continue',
    journal: false,
    autonomous: true,
  });
  sched.on((e) => events.push(e));

  await sched.start();

  const completed = events.find((e) => e.type === 'loop_completed');
  assert.ok(completed, 'should emit loop_completed');
  assert.equal(completed.totalIterations, 2, 'should run 2 iterations (continue then done)');

  // Every isolated iteration keeps the original goal, while the second one
  // also carries the judge-selected focus and previous evidence.
  assert.match(agent._chatLog[0], /Original goal: Fix the parser bug and add a test/);
  assert.match(agent._chatLog[0], /Current focus: Fix the parser bug and add a test/);
  assert.match(agent._chatLog[1], /Original goal: Fix the parser bug and add a test/);
  assert.match(agent._chatLog[1], /Current focus: add a regression test for the parser bug/);
  assert.match(agent._chatLog[1], /Previous iteration evidence:\nFixed the parser bug/);
  console.log('✓ autonomous loop continues with model-suggested prompt, then stops on DONE');
}

// ─── Test 3: Loop respects maxIterations even if model never says DONE ────────
{
  const agent = createMockAgent({
    chatResponses: ['working...', 'still working...', 'more work...'],
    completionResponses: ['CONTINUE: keep going'],
  });

  const events = [];
  const sched = new LoopScheduler(agent, {
    prompt: 'Never-ending task',
    intervalMs: 0,
    maxIterations: 3,
    sessionKey: 'test-loop-max',
    journal: false,
    autonomous: true,
  });
  sched.on((e) => events.push(e));

  await sched.start();

  const paused = events.find((e) => e.type === 'loop_paused');
  assert.ok(paused, 'should pause at maxIterations without claiming task completion');
  assert.equal(paused.iteration, 3, 'should stop at maxIterations=3');
  assert.match(paused.reason, /iteration limit/);
  console.log('✓ autonomous loop pauses at maxIterations when model never says DONE');
}

console.log('\nAll autonomous loop tests passed.');
