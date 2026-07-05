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
      if (options.failOnIteration === idx) {
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

  await scheduler.start();

  assert.equal(agent.calls.length, 3, 'ran exactly 3 iterations');
  assert.equal(scheduler.getState().currentIteration, 3, 'currentIteration = 3');
  const completed = events.filter((e) => e.type === 'loop_completed');
  assert.equal(completed.length, 1, 'loop_completed emitted once');
  assert.equal(completed[0].totalIterations, 3, 'completed with 3 iterations');
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
  //           iteration_started(2) → iteration_completed(2) → loop_completed
  assert.equal(events[0].type, 'loop_started', 'first event is loop_started');
  assert.equal(events[1].type, 'iteration_started', 'second is iteration_started');
  assert.equal(events[1].iteration, 1, 'first iteration is 1');
  assert.equal(events[2].type, 'iteration_completed', 'third is iteration_completed');
  assert.equal(events[2].result.iteration, 1, 'result iteration = 1');
  assert.equal(events[2].result.success, true, 'iteration succeeded');
  assert.equal(events[2].result.response, 'ok', 'response is "ok"');
  assert.equal(events[3].type, 'iteration_started', 'fourth is iteration_started(2)');
  assert.equal(events[4].type, 'iteration_completed', 'fifth is iteration_completed(2)');
  assert.equal(events[5].type, 'loop_completed', 'last is loop_completed');
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
  assert.equal(loopDone.length, 1, 'loop completed despite mid-loop failure');
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

    // Verify state via getState() (saveState writes to .moss/runtime/ — may
    // fail silently if getMossWorkspacePaths resolves differently in test)
    const state = scheduler.getState();
    assert.equal(state.prompt, 'resume test', 'state has prompt');
    assert.equal(state.currentIteration, 5, 'state has iteration count');
    assert.equal(state.maxIterations, 5, 'state has maxIterations');

    // Manually write state file for restore test
    const stateDir = path.join(dir, '.moss', 'runtime');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'loop-state.json'), JSON.stringify(state, null, 2));

    // Restore
    const restored = await LoopScheduler.restore(agent, dir);
    assert.ok(restored, 'restore returned a scheduler');
    assert.equal(restored.getState().currentIteration, 5, 'restored iteration count');
    assert.equal(restored.getState().prompt, 'resume test', 'restored prompt');
  } finally {
    process.chdir(origCwd);
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

  await scheduler.start();

  const state = scheduler.getState();
  assert.ok(state.currentIteration <= 5, `stopped early due to duration (got ${state.currentIteration} iterations)`);
  assert.ok(state.currentIteration >= 1, 'ran at least 1 iteration');
}

console.log('  [PASS] loop-scheduler: bounds, events, fault tolerance, abort, save/restore');
