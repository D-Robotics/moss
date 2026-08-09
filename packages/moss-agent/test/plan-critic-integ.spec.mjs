#!/usr/bin/env node
import assert from 'node:assert/strict';
import { planTool } from '../dist/plan-execute/plan-tools.js';
import {
  getPlanController,
  resetPlanControllerStoreForTests,
} from '../dist/plan-execute/plan-controller-store.js';

const previous = {
  enabled: process.env.MOSS_PLAN_VALIDATE,
  minSteps: process.env.MOSS_PLAN_VALIDATE_MIN_STEPS,
  timeout: process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS,
};

process.env.MOSS_PLAN_VALIDATE = 'on';
process.env.MOSS_PLAN_VALIDATE_MIN_STEPS = '5';
process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS = '1234';

try {
  resetPlanControllerStoreForTests();
  const sessionKey = 'plan-critic-integration';
  const baseContext = { workspaceDir: process.cwd(), sessionKey };
  const created = await planTool.execute(
    {
      action: 'create',
      goal: 'Implement the feature and verify it',
      steps: Array.from({ length: 5 }, (_, index) => ({
        description: `step ${index + 1}`,
      })),
    },
    baseContext
  );
  const planId = String(created).match(/Plan created:\s*(plan-[^\s]+)/i)?.[1];
  assert.ok(planId, 'plan creation returns an id');

  let captured;
  const blocked = await planTool.execute(
    { action: 'approve', planId },
    {
      ...baseContext,
      async spawnSubagent(params) {
        captured = params;
        return {
          runId: 'critic-run',
          sessionKey: 'subagent:critic-run',
          summary: JSON.stringify({
            ok: false,
            summary: 'verification is missing',
            issues: [
              {
                step: 5,
                severity: 'high',
                problem: 'No verification step',
                suggestedFix: 'Run the relevant tests',
              },
            ],
          }),
          success: true,
        };
      },
    }
  );

  assert.match(String(blocked), /needs revision/i, 'valid critic issues block approval');
  assert.notEqual(getPlanController(sessionKey).getPlan(planId).status, 'approved');
  assert.equal(captured.scope, 'critic', 'critic uses its zero-tool scope');
  assert.equal(captured.maxTurns, 1, 'critic is bounded to one normal turn');
  assert.equal(captured.timeoutMs, 1234, 'configured deadline reaches the child run');
  assert.match(captured.systemPromptOverride, /Return ONLY a JSON object/i);
  assert.match(
    captured.task,
    /Implement the feature and verify it/,
    'plan goal supplies task context'
  );

  const approved = await planTool.execute(
    { action: 'approve', planId },
    {
      ...baseContext,
      async spawnSubagent() {
        return {
          runId: 'critic-run-ok',
          sessionKey: 'subagent:critic-run-ok',
          summary: JSON.stringify({ ok: true, summary: '', issues: [] }),
          success: true,
        };
      },
    }
  );
  assert.match(String(approved), /approved/i, 'valid ok response permits approval');
  assert.equal(getPlanController(sessionKey).getPlan(planId).status, 'approved');
} finally {
  if (previous.enabled === undefined) delete process.env.MOSS_PLAN_VALIDATE;
  else process.env.MOSS_PLAN_VALIDATE = previous.enabled;
  if (previous.minSteps === undefined) delete process.env.MOSS_PLAN_VALIDATE_MIN_STEPS;
  else process.env.MOSS_PLAN_VALIDATE_MIN_STEPS = previous.minSteps;
  if (previous.timeout === undefined) delete process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS;
  else process.env.MOSS_PLAN_VALIDATE_TIMEOUT_MS = previous.timeout;
  resetPlanControllerStoreForTests();
}

console.log('[PASS] plan-critic integration: blocked/approved wiring, scope, task, deadline');
