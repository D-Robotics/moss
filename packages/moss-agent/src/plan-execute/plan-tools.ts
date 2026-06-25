/**
 * Plan and Plan-Step tools — expose the PlanExecuteController as tools for the Moss agent.
 *
 * @public
 */
import type { Tool } from '../core/tools/tool-types.js';
import {
  PlanExecuteController,
} from './plan-execute-controller.js';

export interface PlanToolInput {
  /** Action: create, review, approve, start, cancel, status, or format. */
  action: 'create' | 'review' | 'approve' | 'start' | 'cancel' | 'status' | 'format';
  /** Plan ID (required for all actions except "create"). */
  planId?: string;
  /** Goal description (required for "create"). */
  goal?: string;
  /** Steps for plan creation. */
  steps?: Array<{
    description: string;
    expectedTools?: string[];
    expectedOutput?: string;
    dependsOn?: number[];
    estimatedTimeSec?: number;
  }>;
  /** Plan rationale (optional, for "create"). */
  rationale?: string;
  /** Preconditions for the plan (optional). */
  preconditions?: string[];
  /** Success criteria (optional). */
  successCriteria?: string[];
}

export interface PlanStepToolInput {
  /** Plan ID. */
  planId: string;
  /** Step number to act on. */
  stepNumber: number;
  /** Action: complete, fail, skip. */
  action: 'complete' | 'fail' | 'skip';
  /** Actual output after completing a step. */
  actualOutput?: string;
  /** Tools actually used. */
  actualTools?: string[];
  /** Error message (for "fail" action). */
  error?: string;
  /** Reason (for "skip" action). */
  reason?: string;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

// Singleton controller for the plan tools
let controllerInstance: PlanExecuteController | null = null;

function getController(): PlanExecuteController {
  if (!controllerInstance) {
    controllerInstance = new PlanExecuteController({
      maxReplans: 3,
      requireApproval: true,
      autoApproveSimple: true,
    });
  }
  return controllerInstance;
}

/** Reset controller for tests. */
export function resetPlanControllerForTests(): void {
  controllerInstance = null;
}

/**
 * Create a plan management tool.
 *
 * @public
 */
export function createPlanTool(): Tool<PlanToolInput> {
  return {
    name: 'plan',
    description:
      'Manage explicit execution plans. Use this to create structured plans before executing complex tasks. ' +
      'This enables Plan → Execute separation: first plan the work, then execute step by step.\n' +
      'Actions:\n' +
      '- "create": Create a new plan with a goal, steps, and optional rationale\n' +
      '- "review": Review a plan for issues (validates structure, dependencies)\n' +
      '- "approve": Approve a reviewed plan for execution\n' +
      '- "start": Begin executing an approved plan\n' +
      '- "cancel": Cancel an active plan\n' +
      '- "status": Get current execution status\n' +
      '- "format": Get a formatted view of the plan',
    metadata: {
      sideEffectClass: 'runtime_state',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'review', 'approve', 'start', 'cancel', 'status', 'format'],
          description: 'Action to perform on the plan.',
        },
        planId: {
          type: 'string',
          description: 'Plan ID (required for all actions except "create").',
        },
        goal: {
          type: 'string',
          description: 'High-level goal description (required for "create").',
        },
        steps: {
          type: 'array',
          description: 'Ordered list of steps (required for "create").',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What this step accomplishes.' },
              expectedTools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tools expected to be used in this step.',
              },
              expectedOutput: { type: 'string', description: 'Expected output description.' },
              dependsOn: {
                type: 'array',
                items: { type: 'number' },
                description: 'Step numbers this step depends on.',
              },
              estimatedTimeSec: { type: 'number', description: 'Estimated time in seconds.' },
            },
            required: ['description'],
          },
        },
        rationale: { type: 'string', description: 'Overall plan rationale/strategy.' },
        preconditions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Preconditions that must be met.',
        },
        successCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Criteria for plan success.',
        },
      },
      required: ['action'],
    },
    async execute(input, _ctx) {
      try {
        const controller = getController();

        switch (input.action) {
          case 'create': {
            if (!input.goal || !input.steps || input.steps.length === 0) {
              return 'Error: goal and steps are required for plan creation.';
            }

            const planSteps = input.steps.map((s, i) => ({
              step: i + 1,
              description: s.description,
              expectedTools: s.expectedTools,
              expectedOutput: s.expectedOutput,
              dependsOn: s.dependsOn,
              estimatedTimeSec: s.estimatedTimeSec,
            }));

            const plan = controller.createPlan(input.goal, planSteps, input.rationale);

            if (input.preconditions) plan.preconditions = input.preconditions;
            if (input.successCriteria) plan.successCriteria = input.successCriteria;

            return `Plan created: ${plan.id}\n\n${PlanExecuteController.formatPlan(plan)}`;
          }

          case 'review': {
            if (!input.planId) return 'Error: planId is required for review.';
            const result = controller.reviewPlan(input.planId);
            const lines: string[] = [];
            lines.push(result.approved ? '[plan: approved]' : '[plan: needs review]');
            if (result.issues.length > 0) {
              lines.push('Issues:');
              for (const issue of result.issues) lines.push(`  - ${issue}`);
            }
            if (result.suggestions.length > 0) {
              lines.push('Suggestions:');
              for (const s of result.suggestions) lines.push(`  - ${s}`);
            }
            if (result.approved && !result.issues.length) {
              lines.push('Plan is valid and ready for execution.');
            }
            return lines.join('\n');
          }

          case 'approve': {
            if (!input.planId) return 'Error: planId is required for approval.';
            const ok = controller.approvePlan(input.planId);
            return ok ? `Plan ${input.planId} approved.` : `Error: could not approve plan ${input.planId}.`;
          }

          case 'start': {
            if (!input.planId) return 'Error: planId is required to start execution.';
            const ok = controller.startExecution(input.planId);
            if (!ok) return `Error: could not start plan ${input.planId}. Ensure it is approved.`;

            const plan = controller.getPlan(input.planId);
            return plan
              ? `Plan execution started.\n\n${PlanExecuteController.formatPlan(plan)}`
              : `Plan ${input.planId} execution started.`;
          }

          case 'cancel': {
            if (!input.planId) return 'Error: planId is required to cancel.';
            const ok = controller.cancelPlan(input.planId);
            return ok ? `Plan ${input.planId} cancelled.` : `Error: could not cancel plan ${input.planId}.`;
          }

          case 'status': {
            if (!input.planId) return 'Error: planId is required for status.';
            const state = controller.getExecutionState(input.planId);
            if (!state) return `Error: plan ${input.planId} not found.`;

            const plan = controller.getPlan(input.planId);
            const lines: string[] = [];
            lines.push(`Plan: ${plan?.goal ?? input.planId}`);
            lines.push(`Status: ${plan?.status ?? 'unknown'}`);
            lines.push(`Progress: ${state.completedSteps}/${state.totalSteps} steps completed`);
            if (state.isExecuting) lines.push(`Current step: ${state.currentStep}`);
            if (state.lastError) lines.push(`Last error: ${state.lastError}`);
            return lines.join('\n');
          }

          case 'format': {
            if (!input.planId) return 'Error: planId is required for formatting.';
            const plan = controller.getPlan(input.planId);
            if (!plan) return `Error: plan ${input.planId} not found.`;
            return PlanExecuteController.formatPlan(plan);
          }

          default:
            return `Error: unknown action "${(input as any).action}".`;
        }
      } catch (err) {
        throw toolError('Plan tool error', err);
      }
    },
  };
}

/**
 * Create a plan step execution tool.
 *
 * @public
 */
export function createPlanStepTool(): Tool<PlanStepToolInput> {
  return {
    name: 'plan_step',
    description:
      'Update the status of a plan step during execution. ' +
      'Use this to mark steps as complete, failed, or skipped as you execute a plan.\n' +
      'Actions:\n' +
      '- "complete": Mark a step as completed with actual output\n' +
      '- "fail": Mark a step as failed with an error message\n' +
      '- "skip": Skip a step with a reason',
    metadata: {
      sideEffectClass: 'runtime_state',
      planMode: 'allow',
    },
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan ID.' },
        stepNumber: { type: 'number', description: 'Step number to act on (1-based).' },
        action: {
          type: 'string',
          enum: ['complete', 'fail', 'skip'],
          description: 'Action to take on the step.',
        },
        actualOutput: { type: 'string', description: 'Actual output after completing the step.' },
        actualTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools actually used during the step.',
        },
        error: { type: 'string', description: 'Error message (for "fail" action).' },
        reason: { type: 'string', description: 'Reason for skipping (for "skip" action).' },
      },
      required: ['planId', 'stepNumber', 'action'],
    },
    async execute(input, _ctx) {
      try {
        const controller = getController();

        switch (input.action) {
          case 'complete': {
            const ok = controller.completeStep(
              input.planId,
              input.stepNumber,
              input.actualOutput,
              input.actualTools,
            );
            if (!ok) return `Error: could not complete step ${input.stepNumber} in plan ${input.planId}.`;

            const state = controller.getExecutionState(input.planId);
            const plan = controller.getPlan(input.planId);
            if (plan?.status === 'completed') {
              return `Step ${input.stepNumber} completed. All steps done — plan execution complete!`;
            }
            return `Step ${input.stepNumber} completed. ${state ? `Progress: ${state.completedSteps}/${state.totalSteps}` : ''}`;
          }

          case 'fail': {
            if (!input.error) return 'Error: error message is required for "fail" action.';
            const ok = controller.failStep(input.planId, input.stepNumber, input.error);
            return ok
              ? `Step ${input.stepNumber} failed: ${input.error}`
              : `Error: could not mark step ${input.stepNumber} as failed.`;
          }

          case 'skip': {
            const reason = input.reason ?? 'No reason provided';
            const ok = controller.skipStep(input.planId, input.stepNumber, reason);
            if (!ok) return `Error: could not skip step ${input.stepNumber} in plan ${input.planId}.`;

            const plan = controller.getPlan(input.planId);
            if (plan?.status === 'completed') {
              return `Step ${input.stepNumber} skipped. All remaining steps done — plan execution complete!`;
            }
            return `Step ${input.stepNumber} skipped: ${reason}`;
          }

          default:
            return `Error: unknown action "${(input as any).action}".`;
        }
      } catch (err) {
        throw toolError('Plan step error', err);
      }
    },
  };
}

/**
 * Default plan tool instance.
 *
 * @public
 */
export const planTool: Tool<PlanToolInput> = createPlanTool();

/**
 * Default plan step tool instance.
 *
 * @public
 */
export const planStepTool: Tool<PlanStepToolInput> = createPlanStepTool();
