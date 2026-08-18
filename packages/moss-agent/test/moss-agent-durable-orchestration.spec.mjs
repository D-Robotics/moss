#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { JsonlExecutionStore } from '../dist/orchestration/index.js';
import { createGoalCheckpointMessage, createGoalState } from '../dist/core/goal/goal-state.js';
import { createTaskFrameCheckpointMessage } from '../dist/core/goal/task-frame.js';

const provider = {
  id: 'unused',
  displayName: 'unused',
  capabilities: { streaming: false },
  async complete() {
    return { content: [{ type: 'text', text: 'unused' }], stopReason: 'end_turn' };
  },
};

function createAgent(workspaceDir, config = {}) {
  return new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    enableSteering: false,
    ...config,
  });
}

test('MossAgent defaults to durable execution state shared across restarts', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-durable-'));
  const first = createAgent(workspaceDir);
  try {
    assert.ok(first.executionStore instanceof JsonlExecutionStore);
    first.executionStore.create({
      id: 'restartable',
      goal: 'survive restart',
      sessionId: 'session',
      nodes: [],
      policy: { maxConcurrency: 4, maxAttemptsPerNode: 3, strictCompletion: true },
    });
    await first.close();

    const second = createAgent(workspaceDir);
    try {
      assert.equal(second.executionStore.load('restartable').goal, 'survive restart');
      assert.equal(second.planControllerStore.getActivePlanForSession('session'), null);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('MossAgent routes graph nodes through authorized role snapshots and structured synthesis', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-routed-'));
  const agent = createAgent(workspaceDir, {
    agentRoles: [
      {
        id: 'architecture-advisor',
        displayName: 'Architecture advisor',
        kind: 'advisor',
        capabilities: ['architecture'],
        instructions: 'Return structured evidence.',
        workspaceMode: 'shared-readonly',
        outputContract: 'structured-v1',
      },
    ],
  });
  try {
    let graph = agent.executionStore.create({
      id: 'routed',
      goal: 'route by capability',
      nodes: [
        {
          id: 'analyse',
          kind: 'analysis',
          title: 'Analyse architecture',
          dependencies: [],
          requiredCapabilities: ['architecture'],
        },
      ],
    });
    agent.tasks.resume(graph.id);
    let routedRole;
    const outcome = await agent.runRoutedExecutionGraph(graph.id, async (routed) => {
      routedRole = routed.role;
      return {
        assignmentId: routed.assignment.id,
        roleId: routed.role.id,
        status: 'PASS',
        claims: [
          {
            id: 'architecture-claim',
            subject: 'execution authority',
            conclusion: 'the graph owns execution state',
            severity: 'low',
            evidenceRefs: [],
          },
        ],
        evidenceRefs: ['architecture-claim'],
        unmetCriteria: [],
        runId: 'independent-advisor-run',
      };
    });
    assert.equal(routedRole.id, 'architecture-advisor');
    assert.equal(Object.isFrozen(routedRole), true);
    assert.equal(outcome.synthesis.coverage, 1);
    assert.equal(outcome.completion.verdict, 'verified');
    assert.equal(agent.tasks.inspect(graph.id).status, 'completed');
  } finally {
    await agent.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('routed coding work merges an approved isolated patch and requires a fresh verifier receipt', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-routed-coding-'));
  fs.writeFileSync(path.join(workspaceDir, 'target.txt'), 'before\n');
  const agent = createAgent(workspaceDir, {
    allowPluginIsolatedWrite: true,
    agentRoles: [
      {
        id: 'implementer',
        displayName: 'Implementer',
        kind: 'implementer',
        capabilities: ['code'],
        instructions: 'Write only in the lease.',
        workspaceMode: 'isolated-write',
        outputContract: 'structured-v1',
      },
      {
        id: 'verifier',
        displayName: 'Verifier',
        kind: 'verifier',
        capabilities: ['test'],
        instructions: 'Verify independently.',
        workspaceMode: 'shared-readonly',
        outputContract: 'structured-v1',
      },
    ],
  });
  try {
    const graph = agent.executionStore.create({
      id: 'routed-coding',
      goal: 'change and verify',
      nodes: [
        {
          id: 'implement',
          kind: 'implementation',
          title: 'Implement',
          dependencies: [],
          requiredCapabilities: ['code'],
          writePaths: ['target.txt'],
          acceptanceCriteria: ['patch-merged'],
        },
        {
          id: 'verify',
          kind: 'verification',
          title: 'Verify',
          dependencies: ['implement'],
          requiredCapabilities: ['test'],
          acceptanceCriteria: ['tests-green'],
        },
      ],
    });
    agent.tasks.resume(graph.id);
    const executor = async (routed) => {
      if (routed.role.kind === 'implementer') {
        fs.writeFileSync(path.join(routed.workspaceLease.workspacePath, 'target.txt'), 'after\n');
        const patch = await agent.workspaceLeaseAdapter.createPatch(routed.workspaceLease);
        return {
          assignmentId: routed.assignment.id,
          roleId: routed.role.id,
          status: 'PASS',
          claims: [],
          evidenceRefs: [],
          patchRef: patch.id,
          unmetCriteria: [],
          runId: 'implementation-run',
        };
      }
      return {
        assignmentId: routed.assignment.id,
        roleId: routed.role.id,
        status: 'PASS',
        claims: [],
        evidenceRefs: [],
        verification: { command: 'test', exitCode: 0, summary: 'focused test passed' },
        unmetCriteria: [],
        runId: 'verifier-run',
      };
    };
    const authorizeMerge = async () => {};
    const first = await agent.runRoutedExecutionGraph(graph.id, executor, 'coding', authorizeMerge);
    assert.equal(first.completion, undefined);
    const second = await agent.runRoutedExecutionGraph(
      graph.id,
      executor,
      'coding',
      authorizeMerge
    );
    assert.equal(second.completion.verdict, 'verified');
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, 'target.txt'), 'utf8').replaceAll('\r\n', '\n'),
      'after\n'
    );
  } finally {
    await agent.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('MossAgent restart pauses active graphs while keeping unstarted ready work resumable', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-recovery-'));
  const first = createAgent(workspaceDir);
  try {
    let graph = first.executionStore.create({
      id: 'recoverable',
      goal: 'resume safely',
      nodes: [{ id: 'work', kind: 'analysis', title: 'Work', dependencies: [] }],
    });
    first.tasks.resume(graph.id);
    graph = first.executionScheduler.reconcile(graph.id);
    assert.equal(graph.nodes.work.status, 'ready');
    await first.close();

    const second = createAgent(workspaceDir);
    try {
      graph = second.tasks.inspect('recoverable');
      assert.equal(graph.status, 'paused_recovered');
      assert.equal(graph.nodes.work.status, 'ready');
      second.tasks.resume(graph.id);
      let executions = 0;
      const outcome = await second.runExecutionGraph(graph.id, async () => {
        executions += 1;
        return {
          success: true,
          evidence: [
            {
              id: 'recovered-work',
              kind: 'tool_result',
              summary: 'fresh recovered execution',
              createdAt: Date.now(),
            },
          ],
        };
      });
      assert.equal(executions, 1);
      assert.equal(outcome.completion.verdict, 'verified');
      assert.equal(second.tasks.inspect(graph.id).status, 'completed');
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('first checkpoint read imports legacy Goal and TaskFrame state without removing messages', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-agent-checkpoint-import-'));
  const sessionStore = new InMemorySessionStore();
  const sessionKey = 'legacy-session';
  const goal = createGoalState({ sessionKey, objective: 'Finish legacy work' });
  const frame = {
    schemaVersion: 1,
    sessionKey,
    runId: 'legacy-run',
    goal: 'Finish legacy work',
    constraints: [],
    currentStep: 'Inspect state',
    completedSteps: [],
    pendingSteps: ['Apply fix'],
    artifacts: [],
    importantPaths: [],
    toolFindings: [],
    nextAction: 'Continue',
    status: 'paused_resumable',
    source: 'error',
    updatedAt: 1,
  };
  const messages = [createGoalCheckpointMessage(goal), createTaskFrameCheckpointMessage(frame)];
  await sessionStore.replaceMessages(sessionKey, messages);
  const agent = createAgent(workspaceDir, { sessionStore });
  try {
    assert.equal((await agent.getGoal(sessionKey)).objective, goal.objective);
    await agent.chat(sessionKey, 'continue');
    const imported = agent.tasks.list().filter(({ id }) => id.startsWith('legacy_'));
    assert.equal(
      imported.some(({ id }) => id.startsWith('legacy_goal_')),
      true
    );
    assert.equal(
      imported.some(({ id }) => id.startsWith('legacy_task_frame_')),
      true
    );
    assert.equal((await sessionStore.loadMessages(sessionKey)).length >= messages.length, true);
    const markers = fs
      .readdirSync(path.join(workspaceDir, '.moss', 'runtime', 'legacy-checkpoints'))
      .filter((name) => name.endsWith('.execution-graph-migration-v1.json'));
    assert.equal(markers.length, 2);
  } finally {
    await agent.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
