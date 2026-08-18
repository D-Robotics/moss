#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { TaskRunLedger } from '../dist/core/task-run/task-run-ledger.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { MossWebRuntimeService } from '../dist/web-ui/web-runtime-service.js';

function createAgent() {
  return new MossAgent({
    llmProvider: {
      id: 'web-runtime-test',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'runtime-model',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
    subagentExperts: [
      {
        id: 'reviewer',
        displayName: 'Reviewer',
        description: 'Reviews code',
        instructions: 'Review only.',
        scope: 'read-only',
      },
    ],
  });
}

test('Web runtime service reuses inbox, goal, async task, and run evidence owners', async () => {
  const agent = createAgent();
  const ledger = new TaskRunLedger();
  const service = new MossWebRuntimeService(agent, ledger);
  try {
    const queued = service.admit('session-a', 'Do this next', 'queue');
    assert.equal(queued.delivery, 'queue');
    assert.equal(service.inbox('session-a')[0].prompt, 'Do this next');
    assert.equal(
      service.steer('session-a', 'Change direction'),
      null,
      'steer needs one active run'
    );

    const goal = await service.setGoal('session-a', 'Ship the Web runtime');
    assert.equal(goal.status, 'active');
    assert.equal((await service.goal('session-a')).objective, 'Ship the Web runtime');

    agent.asyncTasks.start(
      { taskId: 'job-a', kind: 'host_task', label: 'Background check', payload: {} },
      async (_request, signal) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { success: false, summary: 'stopped' };
      }
    );
    assert.equal(service.jobs()[0].taskId, 'job-a');
    assert.equal(service.stopJob('job-a'), true);

    ledger.create({ id: 'run-a', sessionId: 'session-a', title: 'Evidence run' });
    ledger.append('run-a', { type: 'run.started' });
    ledger.append('run-a', { type: 'tool.started', data: { name: 'read_file' } });
    ledger.append('run-a', { type: 'tool.succeeded', data: { name: 'read_file' } });
    ledger.append('run-a', { type: 'run.completed' });
    ledger.append('run-a', { type: 'run.verified' });
    const trajectory = service.trajectory('run-a');
    assert.equal(trajectory.run.verification, 'verified');
    assert.equal(trajectory.evidence.length, 2);
    assert.equal(service.completionVerdict('run-a').verdict, 'verified');
  } finally {
    await agent.close();
  }
});

test('Web runtime service dispatches the real slash registry and exposes mention inventory', async () => {
  const agent = createAgent();
  const service = new MossWebRuntimeService(agent, new TaskRunLedger());
  try {
    const result = await service.dispatchSlash('session-b', '/mode plan');
    assert.equal(result.handled, true);
    assert.equal(result.mode, 'plan');
    assert.match(result.messages[0].text, /plan/i);

    const inventory = service.mentionInventory();
    assert.ok(inventory.commands.includes('/mode'));
    assert.deepEqual(
      inventory.experts.map(({ id }) => id),
      ['reviewer']
    );
  } finally {
    await agent.close();
  }
});

test('Web interaction mode is isolated between runtime service instances', async () => {
  const firstAgent = createAgent();
  const secondAgent = createAgent();
  const first = new MossWebRuntimeService(firstAgent, new TaskRunLedger());
  const second = new MossWebRuntimeService(secondAgent, new TaskRunLedger());
  try {
    first.setMode('plan');
    second.setMode('accept-edits');
    assert.equal(first.mode(), 'plan');
    assert.equal(second.mode(), 'acceptEdits');
    await first.dispatchSlash('first', '/mode default');
    assert.equal(first.mode(), 'default');
    assert.equal(second.mode(), 'acceptEdits');
  } finally {
    await Promise.all([firstAgent.close(), secondAgent.close()]);
  }
});
