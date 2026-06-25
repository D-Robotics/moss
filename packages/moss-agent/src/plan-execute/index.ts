/**
 * Plan-Execute module — explicit planning phase before execution.
 *
 * Provides a structured Plan → Execute separation:
 * 1. Planning phase: agent analyzes the task and produces a step-by-step plan
 * 2. Plan review: plan is validated and approved (automatic or user-confirmed)
 * 3. Execution phase: agent follows the plan step by step
 * 4. Progress tracking: each step completion is recorded against the plan
 * 5. Replanning: if execution deviates, the plan can be revised
 *
 * Unlike the existing plan-mode approval pattern (which just gates tool execution),
 * this module provides an explicit planning stage with structured plan documents,
 * step tracking, and plan-vs-actual comparison.
 *
 * @module plan-execute
 * @public
 */
export {
  PlanExecuteController,
  type PlanExecuteConfig,
  type Plan,
  type PlanStep,
  type PlanStatus,
  type StepStatus,
  type ExecutionState,
  type PlanReviewResult,
} from './plan-execute-controller.js';

export {
  createPlanTool,
  planTool,
  createPlanStepTool,
  planStepTool,
  resetPlanControllerForTests,
  type PlanToolInput,
  type PlanStepToolInput,
} from './plan-tools.js';

export {
  buildPlanExecuteSystemPrompt,
  type PlanExecutePromptOptions,
} from './plan-execute-prompt.js';
