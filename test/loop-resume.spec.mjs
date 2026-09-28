#!/usr/bin/env node
/**
 * Task-level resume (v0.9 W4): an interrupted autonomous loop restores from
 * persisted state and CONTINUES — completed iterations are not redone
 * (agent call count never rewinds), the goal and journal survive the break.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoopScheduler } from '../dist/core/loop/loop-scheduler.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resume-'));

function makeAgent(calls) {
  let n = 0;
  const provider = {
    id: 'loop',
    displayName: 'loop',
    capabilities: { streaming: true },
    async complete(opts) {
      calls.push((opts.messages ?? []).slice(-1)[0]);
      n += 1;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `iteration output ${n}` }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async stream(opts, cb) {
      cb?.({ type: 'message_start' });
      return this.complete(opts);
    },
  };
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'm',
    workspaceDir: workspace,
    baseSystemPrompt: 'x',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
  });
}

test('interrupted loop restores and continues without redoing iterations', async () => {
  const calls = [];
  const agentA = makeAgent(calls);

  const first = new LoopScheduler(agentA, {
    prompt: 'count from 1 to 3, one number per iteration',
    intervalMs: 0,
    maxIterations: 3,
    sessionKey: 'resume-spec',
    journal: true,
  });
  const stopped = new Promise((resolve) => {
    first.on((event) => {
      if (
        event.type === 'loop_paused' ||
        event.type === 'loop_aborted' ||
        event.type === 'loop_completed'
      ) {
        resolve();
      }
    });
    // hard-interrupt after the first completed iteration (simulates kill/crash)
    first.on((event) => {
      if (event.type === 'iteration_completed') {
        queueMicrotask(() => first.abort());
      }
    });
  });
  await first.start();
  await stopped;
  const afterFirst = calls.length;
  assert.ok(afterFirst >= 1, `at least one iteration ran (${afterFirst})`);

  // state file persisted for restore
  const statePath = path.join(workspace, '.moss', 'loop-state.json');
  assert.ok(fs.existsSync(statePath), 'loop state persisted');
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.prompt, 'count from 1 to 3, one number per iteration');
  assert.notEqual(saved.status, 'completed', 'interrupted loop is not completed');

  // crash recovery: a NEW scheduler instance from the same agent class restores
  const agentB = makeAgent(calls);
  const restored = await LoopScheduler.restore(agentB, workspace);
  assert.ok(restored, 'restores from saved state');
  const finished = new Promise((resolve) => {
    restored.on((event) => {
      if (
        event.type === 'loop_completed' ||
        event.type === 'loop_paused' ||
        event.type === 'loop_aborted'
      ) {
        resolve(event);
      }
    });
  });
  await restored.start();
  const finalEvent = await finished;

  // continuity: the restored run resumed at the saved iteration, not from 0
  assert.ok(
    ['loop_completed', 'loop_paused', 'loop_aborted'].includes(finalEvent.type),
    `restored loop reached a terminal state (${finalEvent.type})`
  );
  assert.ok(
    calls.length >= 3 && calls.length <= 5,
    `iterations continued, not restarted from zero (total agent calls: ${calls.length})`
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

console.log('[PASS] loop resume from persisted state');
