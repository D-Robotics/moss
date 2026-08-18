#!/usr/bin/env node
/**
 * LoopScheduler — self-iteration engine tests.
 *
 * Verifies the core loop mechanics WITHOUT needing a real LLM:
 * - Iteration counting + maxIterations bound
 * - Event emission (loop_started, iteration_started, iteration_completed, loop_completed)
 * - State save/restore for resume
 * - Abort propagation
 * - Single-iteration failure doesn't stop the loop
 * - Interval between iterations
 *
 * Uses a mock agent that returns a fixed response.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoopScheduler } from '../dist/core/loop/loop-scheduler.js';
import { InMemoryExecutionStore } from '../dist/orchestration/index.js';

// Mock agent — simulates MossAgent.chat() without a real LLM
function createMockAgent(options = {}) {
  const calls = [];
  const responses = options.responses || ['ok'];
  let callIndex = 0;
  return {
    calls,
    async chat(sessionKey, prompt) {
      calls.push({ sessionKey, prompt, callIndex });
      const idx = callIndex++;
      if (options.alwaysFail || options.failOnIteration === idx) {
        throw new Error(`Simulated failure on iteration ${idx}`);
      }
      return { response: responses[idx % responses.length] || 'ok', stopReason: 'end_turn' };
    },
  };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-loop-test-'));
}

// ─── 1. maxIterations bound ────────────────────────────────────────────────
{
  const agent = createMockAgent();
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test prompt',
    maxIterations: 3,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((e) => events.push(e));

  assert.equal(scheduler.getActiveSessionKey(), undefined);

  await scheduler.start();

  assert.equal(agent.calls.length, 3, 'ran exactly 3 iterations');
  assert.equal(scheduler.getState().currentIteration, 3, 'currentIteration = 3');
  const completed = events.filter((e) => e.type === 'loop_completed');
  assert.equal(completed.length, 0, 'iteration cap does not claim the goal completed');
  assert.equal(events.filter((e) => e.type === 'loop_paused').length, 1);
  assert.equal(scheduler.getState().status, 'paused');
}

// ─── active session key for side-chat snapshots ─────────────────────────────
{
  let release;
  const entered = new Promise((resolve) => {
    release = resolve;
  });
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const agent = {
    async chat() {
      markStarted();
      await entered;
      return { response: 'done', stopReason: 'end_turn' };
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'inspect the robot',
    sessionKey: 'loop',
    maxIterations: 1,
    intervalMs: 0,
    journal: false,
  });
  const running = scheduler.start();
  await started;
  assert.equal(scheduler.getActiveSessionKey(), 'loop:1');
  release();
  await running;
  assert.equal(scheduler.getActiveSessionKey(), undefined);
}

// ─── 2. Event sequence ─────────────────────────────────────────────────────
{
  const agent = createMockAgent();
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 2,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((e) => events.push(e));

  await scheduler.start();

  // Expected: loop_started → iteration_started(1) → iteration_completed(1) →
  //           iteration_started(2) → iteration_completed(2) → loop_paused
  assert.equal(events[0].type, 'loop_started', 'first event is loop_started');
  assert.equal(events[1].type, 'iteration_started', 'second is iteration_started');
  assert.equal(events[1].iteration, 1, 'first iteration is 1');
  assert.equal(events[2].type, 'iteration_completed', 'third is iteration_completed');
  assert.equal(events[2].result.iteration, 1, 'result iteration = 1');
  assert.equal(events[2].result.success, true, 'iteration succeeded');
  assert.equal(events[2].result.response, 'ok', 'response is "ok"');
  assert.equal(events[3].type, 'iteration_started', 'fourth is iteration_started(2)');
  assert.equal(events[4].type, 'iteration_completed', 'fifth is iteration_completed(2)');
  assert.equal(events[5].type, 'loop_paused', 'last is loop_paused at the safety cap');
}

// ─── 3. Single failure doesn't stop the loop ───────────────────────────────
{
  const agent = createMockAgent({ failOnIteration: 1 });
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 3,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((e) => events.push(e));

  await scheduler.start();

  assert.equal(agent.calls.length, 3, 'all 3 iterations attempted');
  const failed = events.filter((e) => e.type === 'iteration_failed');
  assert.equal(failed.length, 1, 'exactly 1 failure');
  assert.equal(failed[0].iteration, 2, 'failure on iteration 2');
  const completed = events.filter((e) => e.type === 'iteration_completed');
  assert.equal(completed.length, 2, '2 successful completions');
  const loopDone = events.filter((e) => e.type === 'loop_completed');
  assert.equal(loopDone.length, 0, 'iteration cap does not claim completion');
  assert.equal(events.filter((e) => e.type === 'loop_paused').length, 1);
}

// ─── 4. Abort stops the loop ───────────────────────────────────────────────
{
  const agent = createMockAgent();
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 100, // effectively unlimited
    intervalMs: 50,
    journal: false,
  });
  const events = [];
  scheduler.on((e) => events.push(e));

  // Abort after first iteration completes
  scheduler.on((e) => {
    if (e.type === 'iteration_completed' && e.result.iteration === 1) {
      scheduler.abort();
    }
  });
  await scheduler.start();

  const aborted = events.filter((e) => e.type === 'loop_aborted');
  assert.ok(aborted.length >= 1, 'loop_aborted emitted');
  assert.equal(scheduler.getState().currentIteration, 1, 'stopped after iteration 1');
}

// ─── 4b. Abort reaches the active agent run and does not count it ──────────
{
  let capturedSignal;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const agent = {
    async chat(_sessionKey, _prompt, options) {
      capturedSignal = options?.abortSignal;
      markStarted();
      await new Promise((resolve) =>
        capturedSignal.addEventListener('abort', resolve, { once: true })
      );
      throw new Error('provider aborted');
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'long task',
    maxIterations: 3,
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));

  const running = scheduler.start();
  await started;
  scheduler.abort();
  await running;

  assert.equal(capturedSignal.aborted, true, 'active run receives the abort signal');
  assert.equal(scheduler.getState().currentIteration, 0, 'aborted iteration is not counted');
  assert.equal(scheduler.getState().status, 'paused');
  assert.equal(events.filter((event) => event.type === 'iteration_failed').length, 0);
  assert.equal(events.filter((event) => event.type === 'loop_aborted').length, 1);
}

// ─── 5. State save + restore ───────────────────────────────────────────────
{
  const dir = await makeTempDir();
  const origCwd = process.cwd();
  process.chdir(dir);

  try {
    const agent = createMockAgent();
    const scheduler = new LoopScheduler(agent, {
      prompt: 'resume test',
      maxIterations: 5,
      intervalMs: 0,
      journal: true,
    });
    await scheduler.start();

    // Verify state via getState().
    const state = scheduler.getState();
    assert.equal(state.prompt, 'resume test', 'state has prompt');
    assert.equal(state.currentIteration, 5, 'state has iteration count');
    assert.equal(state.maxIterations, 5, 'state has maxIterations');

    // Manually write an interrupted state file for restore test.
    const stateDir = path.join(dir, '.moss');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'loop-state.json'),
      JSON.stringify(
        {
          ...state,
          currentIteration: 4,
          paused: true,
          pauseReason: 'stopped by user',
          status: 'paused',
        },
        null,
        2
      )
    );

    // Restore
    const restored = await LoopScheduler.restore(agent, dir);
    assert.ok(restored, 'restore returned a scheduler');
    assert.equal(restored.getState().currentIteration, 4, 'restored iteration count');
    assert.equal(restored.getState().prompt, 'resume test', 'restored prompt');
  } finally {
    process.chdir(origCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── 5b. Restored loops continue instead of restarting ─────────────────────
{
  const dir = await makeTempDir();
  const origCwd = process.cwd();
  process.chdir(dir);

  try {
    const stateDir = path.join(dir, '.moss');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'loop-state.json'),
      JSON.stringify(
        {
          prompt: 'finish the three-stage task',
          currentPrompt: 'complete stage three only',
          intervalMs: 0,
          maxIterations: 3,
          maxDurationMs: 0,
          maxConsecutiveFailures: 5,
          sessionKey: 'loop',
          compactBetweenIterations: true,
          journal: false,
          autonomous: true,
          currentIteration: 2,
          startedAt: Date.now() - 1000,
          totalDurationMs: 1000,
          paused: true,
          pauseReason: 'stopped by user',
          status: 'paused',
        },
        null,
        2
      )
    );

    const agent = createMockAgent();
    agent.config = {
      model: 'test-model',
      llmProvider: {
        id: 'test-provider',
        async complete() {
          return { content: [{ type: 'text', text: 'DONE' }] };
        },
      },
    };

    const restored = await LoopScheduler.restore(agent, dir);
    assert.ok(restored, 'restores a paused loop');
    await restored.start();

    assert.deepEqual(
      agent.calls.map(({ sessionKey, prompt }) => ({ sessionKey, prompt })),
      [
        {
          sessionKey: 'loop:3',
          prompt: agent.calls[0].prompt,
        },
      ],
      'resume runs only the remaining iteration with the saved continuation prompt'
    );
    assert.match(agent.calls[0].prompt, /Original goal: finish the three-stage task/);
    assert.match(agent.calls[0].prompt, /Current focus: complete stage three only/);
    assert.match(
      agent.calls[0].prompt,
      /fan_out_subagents/,
      'autonomous loop steers parallel subtasks'
    );
    assert.match(
      agent.calls[0].prompt,
      /immediately/,
      'autonomous loop steers no idle wait between subtasks'
    );
    assert.equal(restored.getState().currentIteration, 3);
    assert.equal(restored.getState().status, 'completed');
  } finally {
    process.chdir(origCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── 5c. Completed loop state is not resumable ──────────────────────────────
{
  const dir = await makeTempDir();
  const stateDir = path.join(dir, '.moss');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'loop-state.json'),
    JSON.stringify({
      prompt: 'already done',
      intervalMs: 0,
      maxIterations: 1,
      maxDurationMs: 0,
      sessionKey: 'loop',
      currentIteration: 1,
      startedAt: Date.now(),
      totalDurationMs: 1,
      paused: false,
      status: 'completed',
    })
  );
  try {
    assert.equal(await LoopScheduler.restore(createMockAgent(), dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── 6. maxDurationMs bound ────────────────────────────────────────────────
{
  // Mock agent with a small delay so duration accumulates
  const agent = {
    calls: [],
    async chat(sessionKey, prompt) {
      this.calls.push({ sessionKey, prompt });
      await new Promise((r) => setTimeout(r, 20)); // 20ms per iteration
      return { response: 'ok', stopReason: 'end_turn' };
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 0, // unlimited
    maxDurationMs: 50, // 50ms — should stop after ~2-3 iterations
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));

  await scheduler.start();

  const state = scheduler.getState();
  assert.ok(
    state.currentIteration <= 5,
    `stopped early due to duration (got ${state.currentIteration} iterations)`
  );
  assert.ok(state.currentIteration >= 1, 'ran at least 1 iteration');
  assert.equal(
    state.status,
    'paused',
    'duration safety bound pauses instead of claiming completion'
  );
  assert.equal(events.filter((event) => event.type === 'loop_completed').length, 0);
  assert.equal(events.filter((event) => event.type === 'loop_paused').length, 1);
}

// ─── 7. Consecutive failures pause instead of exhausting the loop ─────────
{
  const agent = createMockAgent({ alwaysFail: true });
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 100,
    maxConsecutiveFailures: 3,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));

  await scheduler.start();

  assert.equal(agent.calls.length, 3, 'stops at the configured consecutive failure limit');
  assert.equal(events.filter((event) => event.type === 'iteration_failed').length, 3);
  assert.equal(events.filter((event) => event.type === 'loop_completed').length, 0);
  assert.equal(events.filter((event) => event.type === 'loop_paused').length, 1);
  assert.equal(scheduler.getState().paused, true, 'state records the paused condition');
  assert.match(scheduler.getState().pauseReason, /3 consecutive failures/);
}

// ─── 8. A successful iteration resets the consecutive failure count ───────
{
  const agent = createMockAgent({ failOnIteration: 1 });
  const scheduler = new LoopScheduler(agent, {
    prompt: 'test',
    maxIterations: 4,
    maxConsecutiveFailures: 2,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));

  await scheduler.start();

  assert.equal(agent.calls.length, 4, 'isolated failure does not stop later work');
  assert.equal(events.filter((event) => event.type === 'loop_completed').length, 0);
  assert.equal(events.filter((event) => event.type === 'loop_paused').length, 1);
}

// ─── 9. Empty completion verdict never claims success ───────────────────────
{
  const agent = createMockAgent({ responses: ['work remains', 'still working'] });
  let judgeCalls = 0;
  agent.config = {
    model: 'test-model',
    llmProvider: {
      id: 'test-provider',
      async complete() {
        judgeCalls++;
        return { content: [] };
      },
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'finish the task',
    maxIterations: 2,
    autonomous: true,
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));

  await scheduler.start();

  assert.equal(judgeCalls, 2, 'empty verdict continues instead of stopping');
  assert.equal(agent.calls.length, 2);
  assert.equal(events.filter((event) => event.type === 'loop_completed').length, 0);
  assert.equal(scheduler.getState().status, 'paused');
}

// ─── 10. Steering during completion judging updates the next iteration ─────
{
  let releaseJudge;
  const judgeGate = new Promise((resolve) => {
    releaseJudge = resolve;
  });
  let markJudgeStarted;
  const judgeStarted = new Promise((resolve) => {
    markJudgeStarted = resolve;
  });
  const agent = createMockAgent({ responses: ['first pass', 'second pass'] });
  let judgeCalls = 0;
  agent.config = {
    model: 'test-model',
    llmProvider: {
      id: 'test-provider',
      async complete() {
        judgeCalls++;
        if (judgeCalls === 1) {
          markJudgeStarted();
          await judgeGate;
          return { content: [{ type: 'text', text: 'DONE' }] };
        }
        return { content: [{ type: 'text', text: 'DONE' }] };
      },
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'prepare the release',
    maxIterations: 3,
    autonomous: true,
    journal: false,
  });

  const running = scheduler.start();
  await judgeStarted;
  assert.equal(
    scheduler.steer('also verify the packaged artifact'),
    true,
    'steering is accepted while the loop is between iterations'
  );
  releaseJudge();
  await running;

  assert.equal(
    agent.calls.length,
    2,
    'the steer prevents the stale DONE verdict from ending the loop'
  );
  assert.match(agent.calls[1].prompt, /Current focus: also verify the packaged artifact/);
  assert.equal(scheduler.getState().status, 'completed');
}

// ─── 11. Steering an active iteration also updates completion criteria ─────
{
  let releaseIteration;
  const iterationGate = new Promise((resolve) => {
    releaseIteration = resolve;
  });
  let markIterationStarted;
  const iterationStarted = new Promise((resolve) => {
    markIterationStarted = resolve;
  });
  const judgePrompts = [];
  const agent = {
    calls: [],
    async chat(sessionKey, prompt) {
      this.calls.push({ sessionKey, prompt });
      markIterationStarted();
      await iterationGate;
      return { response: 'Prepared the release.', stopReason: 'end_turn' };
    },
    steer() {
      return { id: 'steer-1' };
    },
    config: {
      model: 'test-model',
      llmProvider: {
        id: 'test-provider',
        async complete(options) {
          judgePrompts.push(options.messages.map((message) => message.content).join('\n'));
          return { content: [{ type: 'text', text: 'DONE' }] };
        },
      },
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'prepare the release',
    maxIterations: 1,
    autonomous: true,
    journal: false,
  });

  const running = scheduler.start();
  await iterationStarted;
  assert.equal(scheduler.steer('also verify the packaged artifact'), true);
  releaseIteration();
  await running;

  assert.match(judgePrompts[0], /Current user steering focus: also verify the packaged artifact/);
  assert.equal(scheduler.getState().currentPrompt, 'also verify the packaged artifact');
}

console.log(
  '  [PASS] loop-scheduler: bounds, events, fault tolerance, abort, save/restore, failure pause'
);

// ─── streamChat path: live events + done.response preferred ────────────────
{
  const seen = [];
  const agent = {
    async *streamChat(sessionKey, prompt) {
      seen.push({ kind: 'start', sessionKey, prompt: prompt.slice(0, 40) });
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'tool_start', toolCall: { id: '1', name: 'exec', input: {} } };
      yield { type: 'tool_end', toolCallId: '1', result: 'ok' };
      // Final done carries the authoritative response (may include more than deltas).
      yield {
        type: 'done',
        result: { response: 'partial complete answer', stopReason: 'end_turn' },
      };
    },
  };
  const streamEvents = [];
  const scheduler = new LoopScheduler(agent, {
    prompt: 'ship the fix',
    maxIterations: 1,
    intervalMs: 0,
    journal: false,
    onIterationEvent: (e) => streamEvents.push(e.type),
  });
  const events = [];
  scheduler.on((e) => events.push(e));
  await scheduler.start();

  assert.equal(seen.length, 1, 'streamChat called once');
  assert.ok(streamEvents.includes('text_delta'), 'forwards text_delta');
  assert.ok(streamEvents.includes('tool_start'), 'forwards tool_start');
  assert.ok(streamEvents.includes('done'), 'forwards done');
  const completed = events.filter((e) => e.type === 'iteration_completed');
  assert.equal(completed.length, 1);
  // Must prefer done.result.response over partial text_delta accumulation alone
  // when done is present — here both agree; assert the full string is kept.
  assert.equal(completed[0].result.response, 'partial complete answer');
}

// ─── streamChat path: empty deltas, only done.response ─────────────────────
{
  const agent = {
    async *streamChat() {
      // Some providers buffer and only emit done.
      yield { type: 'done', result: { response: 'buffered only', stopReason: 'end_turn' } };
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'goal',
    maxIterations: 1,
    intervalMs: 0,
    journal: false,
  });
  const events = [];
  scheduler.on((e) => events.push(e));
  await scheduler.start();
  const completed = events.filter((e) => e.type === 'iteration_completed');
  assert.equal(completed[0].result.response, 'buffered only');
}

console.error('loop-scheduler: streamChat path + chat fallback ✓');

// ─── Delivery Case gate: high-risk loop cannot invoke the model ───────────
{
  const executionStore = new InMemoryExecutionStore();
  let calls = 0;
  const agent = {
    executionStore,
    async chat() {
      calls += 1;
      return { response: 'must not run', stopReason: 'end_turn' };
    },
  };
  const scheduler = new LoopScheduler(agent, {
    prompt: 'Migrate the public API and plugin permission security contract',
    journal: false,
  });
  const events = [];
  scheduler.on((event) => events.push(event));
  await scheduler.start();
  const graph = executionStore.load(scheduler.getState().executionGraphId);
  assert.equal(calls, 0);
  assert.equal(graph.deliveryCase.depth, 'comprehensive');
  assert.equal(graph.deliveryCase.stage, 'elaborating');
  assert.equal(events.at(-1).type, 'loop_paused');
}

console.error('loop-scheduler: high-risk delivery gate ✓');
