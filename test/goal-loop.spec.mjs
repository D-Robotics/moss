#!/usr/bin/env node
/**
 * Goal loop — acceptance-driven autonomous execution (v0.15 S1).
 *
 * Locks the contract that an external acceptance command is the AUTHORITATIVE
 * completion signal:
 * - acceptance pass → completed (model judge never even runs)
 * - acceptance fail → next iteration targets the failure evidence
 * - a model DONE claim cannot override a failing acceptance command
 * - budget_* stopReason survives the streamChat path (regression: it used to
 *   be dropped, so budget circuit-breakers never fired in real runs)
 * - /goal command-line parsing
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LoopScheduler } from '../dist/core/loop/loop-scheduler.js';
import { parseGoalCommandLine } from '../dist/core/loop/goal-loop.js';

function createGoalAgent({ responses = ['working on it'], workspaceDir }) {
  const calls = [];
  const judgeCalls = [];
  return {
    calls,
    judgeCalls,
    config: {
      workspaceDir,
      model: 'mock',
      llmProvider: {
        async complete() {
          judgeCalls.push(1);
          return { content: [{ type: 'text', text: 'DONE' }] };
        },
      },
    },
    async chat(sessionKey, prompt) {
      calls.push({ sessionKey, prompt });
      const idx = Math.min(calls.length - 1, responses.length - 1);
      return { response: responses[idx], stopReason: 'end_turn' };
    },
  };
}

async function tempWs() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-goal-test-'));
}

// ─── 1. Acceptance pass on first check → completed, judge skipped ───────────

{
  const ws = await tempWs();
  const agent = createGoalAgent({ workspaceDir: ws });
  const sched = new LoopScheduler(agent, {
    prompt: 'make the check pass',
    intervalMs: 0,
    journal: true,
    autonomous: true,
    acceptance: { command: 'exit 0' },
    sessionKey: 'goal-t1',
  });
  const events = [];
  sched.on((e) => events.push(e));
  await sched.start();
  assert.equal(agent.calls.length, 1, 'exactly one iteration ran');
  assert.equal(sched.getState().status, 'completed', 'acceptance pass completes the loop');
  assert.ok(
    events.some((e) => e.type === 'loop_completed'),
    'loop_completed emitted'
  );
  assert.equal(agent.judgeCalls.length, 0, 'model judge is skipped when acceptance passes');
  assert.equal(sched.getState().acceptance.lastExitCode, 0, 'exit code journaled');
}

// ─── 2. Acceptance fails then passes → failure evidence drives iteration 2 ──

{
  const ws = await tempWs();
  const marker = path.join(ws, 'marker');
  // Cross-platform flip-marker probe. Inline `node -e` scripts get truncated
  // by Windows cmd quoting, so the probe lives in a file; the marker path
  // travels through an env var (runAcceptanceCommand inherits process.env).
  const probe = path.join(ws, 'flip-marker.mjs');
  await fs.writeFile(
    probe,
    [
      "import fs from 'node:fs';",
      'const p = process.env.GOAL_LOOP_MARKER;',
      'if (fs.existsSync(p)) process.exit(0);',
      "fs.writeFileSync(p, '');",
      'process.exit(1);',
      '',
    ].join('\n')
  );
  process.env.GOAL_LOOP_MARKER = marker;
  const agent = createGoalAgent({ responses: ['attempt 1', 'attempt 2'], workspaceDir: ws });
  const sched = new LoopScheduler(agent, {
    prompt: 'flip the marker',
    intervalMs: 0,
    journal: true,
    autonomous: true,
    acceptance: {
      command: `node ${probe}`,
    },
    sessionKey: 'goal-t2',
  });
  await sched.start();
  assert.equal(agent.calls.length, 2, 'two iterations: fail then pass');
  assert.equal(sched.getState().status, 'completed');
  assert.ok(
    agent.calls[1].prompt.includes('acceptance command'),
    'second iteration prompt carries the acceptance failure context'
  );
  assert.ok(
    agent.calls[0].prompt.includes('Acceptance command'),
    'iteration prompt tells the model about the acceptance command'
  );
  assert.equal(agent.judgeCalls.length, 0, 'judge skipped while acceptance is authoritative');
}

// ─── 3. Model DONE claim is vetoed by a failing acceptance command ─────────

{
  const ws = await tempWs();
  const agent = createGoalAgent({
    responses: ['goal is complete, all verified'],
    workspaceDir: ws,
  });
  const sched = new LoopScheduler(agent, {
    prompt: 'stubborn goal',
    intervalMs: 0,
    journal: false,
    autonomous: true,
    acceptance: { command: 'exit 7' },
    maxIterations: 2,
    sessionKey: 'goal-t3',
  });
  const events = [];
  sched.on((e) => events.push(e));
  await sched.start();
  assert.equal(sched.getState().status, 'paused', 'vetoed DONE cannot complete the loop');
  assert.ok(!events.some((e) => e.type === 'loop_completed'), 'no loop_completed');
  assert.equal(agent.calls.length, 2, 'ran to the iteration cap');
  assert.equal(sched.getState().acceptance.lastExitCode, 7, 'failing exit code journaled');
  assert.equal(sched.getState().acceptance.passes, 0, 'no passes recorded');
}

// ─── 4. Regression: streamChat done.stopReason must reach the budget guard ──

{
  const ws = await tempWs();
  const judgeCalls = [];
  const agent = {
    config: {
      workspaceDir: ws,
      model: 'mock',
      llmProvider: {
        async complete() {
          judgeCalls.push(1);
          return { content: [{ type: 'text', text: 'DONE' }] };
        },
      },
    },
    async *[Symbol.asyncIterator]() {},
    async *streamChat() {
      yield { type: 'text_delta', delta: 'work' };
      yield {
        type: 'done',
        result: { response: 'did stuff', stopReason: 'budget_tokens_reached' },
      };
    },
  };
  const sched = new LoopScheduler(agent, {
    prompt: 'budgeted goal',
    intervalMs: 0,
    journal: false,
    autonomous: true,
    sessionKey: 'goal-t4',
  });
  const events = [];
  sched.on((e) => events.push(e));
  await sched.start();
  const state = sched.getState();
  assert.equal(state.status, 'paused', `budget stop must pause the loop (got ${state.status})`);
  assert.match(String(state.pauseReason ?? ''), /budget/, 'pause reason names the budget');
}

// ─── 5. parseGoalCommandLine ────────────────────────────────────────────────

{
  assert.deepEqual(parseGoalCommandLine('fix the parser'), { goal: 'fix the parser' });
  assert.deepEqual(parseGoalCommandLine('fix it --accept "npm test"'), {
    goal: 'fix it',
    acceptance: { command: 'npm test' },
  });
  assert.deepEqual(parseGoalCommandLine("fix it --accept='node check.js'"), {
    goal: 'fix it',
    acceptance: { command: 'node check.js' },
  });
  assert.deepEqual(parseGoalCommandLine('fix it --accept node check.js'), {
    goal: 'fix it',
    acceptance: { command: 'node check.js' },
  });
  assert.equal(parseGoalCommandLine(''), null, 'empty line is malformed');
  assert.equal(parseGoalCommandLine('   '), null, 'whitespace-only is malformed');
  assert.equal(parseGoalCommandLine('--accept "npm test"'), null, 'goalless line is malformed');
  assert.equal(parseGoalCommandLine('fix it --accept ""'), null, 'empty acceptance is malformed');
  assert.equal(parseGoalCommandLine('fix it --accept'), null, 'dangling --accept is malformed');
}

console.log('[PASS] goal loop (acceptance-gated autonomy)');
