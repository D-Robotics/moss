#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryExecutionStore } from '../dist/orchestration/index.js';
import {
  createPlanStepTool,
  createPlanTool,
  PlanControllerStore,
} from '../dist/plan-execute/index.js';

test('legacy Plan tools shadow every mutation into the authoritative dependency graph', async () => {
  const plans = new PlanControllerStore();
  const executions = new InMemoryExecutionStore();
  const planTool = createPlanTool(plans, executions);
  const stepTool = createPlanStepTool(plans, executions);
  const ctx = { sessionKey: 'session', workspaceDir: process.cwd() };
  const created = await planTool.execute(
    {
      action: 'create',
      goal: 'parallel plan',
      steps: [
        { description: 'A', dependsOn: [] },
        { description: 'B', dependsOn: [] },
        {
          description: 'merge',
          dependsOn: [1, 2],
          writePaths: ['src'],
          expectedOutput: 'Merged output is present and verified',
        },
      ],
    },
    ctx
  );
  const planId = /Plan created: (\S+)/.exec(created)?.[1];
  assert.ok(planId);
  assert.deepEqual(executions.load(planId).nodes['step-3'].dependencies, ['step-1', 'step-2']);
  assert.deepEqual(executions.load(planId).nodes['step-3'].writePaths, ['src']);

  assert.match(await planTool.execute({ action: 'approve', planId }, ctx), /approved/);
  assert.match(await planTool.execute({ action: 'start', planId }, ctx), /started/);
  assert.equal(executions.load(planId).status, 'running');
  assert.equal(executions.load(planId).nodes['step-1'].status, 'running');
  assert.equal(executions.load(planId).nodes['step-2'].status, 'running');

  await stepTool.execute(
    { action: 'complete', planId, stepNumber: 1, actualOutput: 'A evidence' },
    ctx
  );
  assert.equal(executions.load(planId).nodes['step-1'].status, 'succeeded');
  assert.match(executions.load(planId).evidence[0].summary, /A evidence/);
});

test('first mutation imports a Plan created before execution graphs were enabled', async () => {
  const plans = new PlanControllerStore();
  const legacyTool = createPlanTool(plans);
  const ctx = { sessionKey: 'legacy-session', workspaceDir: process.cwd() };
  const created = await legacyTool.execute(
    { action: 'create', goal: 'legacy plan', steps: [{ description: 'old step' }] },
    ctx
  );
  const planId = /Plan created: (\S+)/.exec(created)?.[1];
  await legacyTool.execute({ action: 'approve', planId }, ctx);
  const executions = new InMemoryExecutionStore();
  const graphAwareTool = createPlanTool(plans, executions);
  await graphAwareTool.execute({ action: 'start', planId }, ctx);
  assert.equal(executions.load(planId).status, 'running');
  assert.equal(executions.load(planId).nodes['step-1'].status, 'running');
});

test('new mutating Plan steps reject missing acceptance before any graph is written', async () => {
  const plans = new PlanControllerStore();
  const executions = new InMemoryExecutionStore();
  const tool = createPlanTool(plans, executions);
  const result = await tool.execute(
    {
      action: 'create',
      goal: 'invalid mutation',
      steps: [{ description: 'edit files', writePaths: ['src'] }],
    },
    { sessionKey: 'atomic-plan', workspaceDir: process.cwd() }
  );
  assert.match(result, /acceptance/i);
  assert.deepEqual(executions.list(), []);
});

test('high-risk Plan compatibility flow cannot lower comprehensive delivery gates', async () => {
  const plans = new PlanControllerStore();
  const executions = new InMemoryExecutionStore();
  const tool = createPlanTool(plans, executions);
  const ctx = { sessionKey: 'secure-plan', workspaceDir: process.cwd() };
  const created = await tool.execute(
    {
      action: 'create',
      goal: 'Migrate the public plugin permission API and security gate',
      steps: [
        {
          description: 'Update the permission contract',
          writePaths: ['src/permissions'],
          expectedOutput: 'Permission contract tests pass',
        },
      ],
      successCriteria: ['Permission contract tests pass'],
    },
    ctx
  );
  const planId = /Plan created: (\S+)/.exec(created)?.[1];
  assert.ok(planId);
  let graph = executions.load(planId);
  assert.equal(graph.deliveryCase.depth, 'comprehensive');
  assert.equal(graph.deliveryCase.elaborationRounds[0].resolved, true);
  assert.match(await tool.execute({ action: 'approve', planId }, ctx), /approved/);
  graph = executions.load(planId);
  assert.equal(graph.deliveryCase.proposal.requiresApproval, true);
  assert.equal(graph.deliveryCase.reviews[0].scope, 'proposal');
  assert.ok(graph.deliveryCase.proposal.approvalEvidenceId);
  assert.match(await tool.execute({ action: 'start', planId }, ctx), /started/);
  assert.equal(executions.load(planId).deliveryCase.stage, 'executing');
});
