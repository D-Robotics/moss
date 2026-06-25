#!/usr/bin/env node
/**
 * Test: Plan-Execute module — controller, tools, and prompt.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/plan-execute.spec.mjs
 */
import assert from 'node:assert/strict';
import { builtinTools } from '../dist/tools/builtin.js';
import {
  PlanExecuteController,
  createPlanTool,
  createPlanStepTool,
  buildPlanExecuteSystemPrompt,
  resetPlanControllerForTests,
} from '../dist/plan-execute/index.js';

// Reset before tests
resetPlanControllerForTests();

// 1. Tools are in builtin tools
const names = builtinTools.map((t) => t.name);
assert.ok(names.includes('plan'), 'builtin tools should include plan');
assert.ok(names.includes('plan_step'), 'builtin tools should include plan_step');

// 2. PlanExecuteController — create plan
const controller = new PlanExecuteController({ autoApproveSimple: false, requireApproval: true });
const plan = controller.createPlan(
  'Build a todo app',
  [
    { description: 'Create project structure' },
    { description: 'Implement data model' },
    { description: 'Add UI components' },
    { description: 'Write tests' },
  ],
  'Standard full-stack approach',
);

assert.ok(plan.id.startsWith('plan-'), 'plan ID should start with plan-');
assert.equal(plan.goal, 'Build a todo app');
assert.equal(plan.steps.length, 4);
assert.equal(plan.status, 'draft');
assert.equal(plan.version, 1);
assert.ok(plan.rationale, 'should have rationale');

// Check step numbering
assert.equal(plan.steps[0].step, 1);
assert.equal(plan.steps[3].step, 4);
assert.equal(plan.steps[0].status, 'pending');

// 3. Review plan
const reviewResult = controller.reviewPlan(plan.id);
assert.equal(reviewResult.approved, false, 'should not auto-approve with requireApproval=true');
assert.equal(reviewResult.issues.length, 0, 'should have no structural issues');

// 4. Review plan with auto-approve
const autoController = new PlanExecuteController({ autoApproveSimple: true, requireApproval: false });
const autoPlan = autoController.createPlan('Simple task', [
  { description: 'Step 1' },
]);
const autoReview = autoController.reviewPlan(autoPlan.id);
assert.equal(autoReview.approved, true, 'should auto-approve simple plan');

// 5. Approve and start execution
assert.equal(controller.approvePlan(plan.id), true);
assert.equal(plan.status, 'approved');

assert.equal(controller.startExecution(plan.id), true);
assert.equal(plan.status, 'executing');
assert.equal(plan.currentStep, 1);
assert.equal(plan.steps[0].status, 'in_progress');

// 6. Complete steps
assert.equal(controller.completeStep(plan.id, 1, 'Created project structure', ['write_file']), true);
assert.equal(plan.steps[0].status, 'completed');
assert.equal(plan.currentStep, 2);
assert.equal(plan.steps[1].status, 'in_progress');

// 7. Skip a step
assert.equal(controller.skipStep(plan.id, 2, 'Not needed'), true);
assert.equal(plan.steps[1].status, 'skipped');
assert.equal(plan.currentStep, 3);

// 8. Fail a step
assert.equal(controller.failStep(plan.id, 3, 'Component library not available'), true);
assert.equal(plan.steps[2].status, 'failed');
assert.equal(plan.steps[2].error, 'Component library not available');

// 9. Get execution state
const state = controller.getExecutionState(plan.id);
assert.ok(state, 'should have execution state');
assert.equal(state.completedSteps, 1, '1 step completed');
assert.equal(state.totalSteps, 4);
assert.ok(state.lastError, 'should have last error');

// 10. Cancel plan
assert.equal(controller.cancelPlan(plan.id), true);
assert.equal(plan.status, 'cancelled');

// 11. Plan with dependencies
const depPlan = controller.createPlan('Task with deps', [
  { description: 'Setup', step: 1 },
  { description: 'Build', step: 2, dependsOn: [1] },
  { description: 'Test', step: 3, dependsOn: [2] },
]);
const depReview = controller.reviewPlan(depPlan.id);
assert.equal(depReview.issues.length, 0, 'valid dependency chain should have no issues');

// 12. Plan with circular dependency detection
const circularPlan = controller.createPlan('Circular task', [
  { description: 'A', dependsOn: [3] },
  { description: 'B', dependsOn: [1] },
  { description: 'C', dependsOn: [2] },
]);
const circularReview = controller.reviewPlan(circularPlan.id);
assert.ok(circularReview.issues.some((i) => i.includes('circular')), 'should detect circular dependency');

// 13. PlanExecuteController.formatPlan
const formatted = PlanExecuteController.formatPlan(plan);
assert.ok(formatted.includes('Build a todo app'), 'should include goal');
assert.ok(formatted.includes('cancelled'), 'should include status');
assert.ok(formatted.includes('Created project structure'), 'should include step descriptions');

// 14. Plan tool
const planToolInstance = createPlanTool();
assert.equal(planToolInstance.name, 'plan');

// Create via tool
const createResult = await planToolInstance.execute(
  {
    action: 'create',
    goal: 'Test plan',
    steps: [
      { description: 'Do something' },
      { description: 'Verify result', expectedTools: ['read_file'] },
    ],
    rationale: 'Simple approach',
  },
  { workspaceDir: '/tmp', sessionKey: 'plan-create' },
);
assert.ok(createResult.includes('Plan created'), 'should confirm plan creation');
const planIdMatch = createResult.match(/plan-\d+-[a-z0-9]+/);
assert.ok(planIdMatch, 'should include plan ID');

if (planIdMatch) {
  const planId = planIdMatch[0];

  // Review
  const reviewResult = await planToolInstance.execute(
    { action: 'review', planId },
    { workspaceDir: '/tmp', sessionKey: 'plan-review' },
  );
  assert.ok(reviewResult.includes('approved') || reviewResult.includes('review'), 'should show review result');

  // Status
  const statusResult = await planToolInstance.execute(
    { action: 'status', planId },
    { workspaceDir: '/tmp', sessionKey: 'plan-status' },
  );
  assert.ok(statusResult.includes('Test plan') || statusResult.includes('Progress'), 'should show status');
}

// 15. Plan step tool
const stepToolInstance = createPlanStepTool();
assert.equal(stepToolInstance.name, 'plan_step');

// 16. System prompt
const prompt = buildPlanExecuteSystemPrompt({ planExecuteEnabled: true });
assert.ok(prompt.includes('Plan → Execute'), 'prompt should mention Plan → Execute');
assert.ok(prompt.includes('Phase 1: Plan'), 'prompt should describe phases');

const promptDisabled = buildPlanExecuteSystemPrompt({ planExecuteEnabled: false });
assert.equal(promptDisabled, '', 'prompt should be empty when disabled');

// 17. Replanning
const replanController = new PlanExecuteController({ maxReplans: 2 });
const replanPlan = replanController.createPlan('Complex task', [
  { description: 'Step 1' },
  { description: 'Step 2' },
]);
replanPlan.status = 'executing';
const revised = replanController.requestReplan(replanPlan.id, 'Need different approach');
assert.ok(revised, 'should allow replanning');
assert.equal(replanPlan.replanCount, 1);

// Second replan should succeed (within max)
const revised2 = replanController.requestReplan(replanPlan.id, 'Still wrong');
assert.ok(revised2, 'should allow second replan');

// Third replan should fail (exceeds maxReplans=2)
const revised3 = replanController.requestReplan(replanPlan.id, 'One more try');
assert.equal(revised3, null, 'should reject third replan');
assert.equal(replanPlan.status, 'failed', 'should mark as failed after max replans');

console.log('[PASS] Plan-Execute module: controller, tools, and prompt work correctly');
