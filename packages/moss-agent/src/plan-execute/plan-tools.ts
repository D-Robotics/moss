




import type { Tool } from '../core/tools/tool-types.js';
import { PlanExecuteController } from './plan-execute-controller.js';
import type { Plan } from './plan-execute-controller.js';
import {
  getPlanController,
  getSharedPlanController,
  setActivePlanId,
  resetPlanControllerStoreForTests,
} from './plan-controller-store.js';
import { errorMessage } from '../errors.js';
import {
  getCliInteractionMode,
  getCliUserQuestionAsker,
  setCliInteractionMode,
} from '../cli/approval.js';

export interface PlanToolInput {
  
  action: 'create' | 'review' | 'approve' | 'start' | 'cancel' | 'status' | 'format';
  
  planId?: string;
  
  goal?: string;
  
  steps?: Array<{
    description: string;
    expectedTools?: string[];
    expectedOutput?: string;
    dependsOn?: number[];
    estimatedTimeSec?: number;
  }>;
  
  rationale?: string;
  
  preconditions?: string[];
  
  successCriteria?: string[];
}

export interface PlanStepToolInput {
  
  planId: string;
  
  stepNumber: number;
  
  action: 'complete' | 'fail' | 'skip';
  
  actualOutput?: string;
  
  actualTools?: string[];
  
  error?: string;
  
  reason?: string;
}

function toolError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${errorMessage(err)}`);
}

/** When a plan is approved/started, leave interactionMode=plan so coding tools can run. */
function leavePlanModeForExecution(): boolean {
  if (getCliInteractionMode() !== 'plan') return false;
  setCliInteractionMode('default');
  return true;
}

function isAffirmativePlanApproval(answer: string): boolean {
  const text = String(answer ?? '').trim().toLowerCase();
  if (!text) return false;
  return /^(y|yes|ok|okay|approve|approved|proceed|go|start|lgtm|确认|好|可以|同意|批准|继续|执行)\b/i.test(
    text,
  );
}

/**
 * Claude ExitPlanMode light: when the session is already in interactionMode=plan,
 * require an interactive user confirmation before plan action=approve commits and
 * drops the plan-mode mutation gate. Non-interactive runs keep previous behavior.
 */
async function confirmPlanApprovalIfNeeded(
  controller: PlanExecuteController,
  planId: string,
  abortSignal?: AbortSignal,
): Promise<'approved' | 'declined' | 'unavailable' | 'skipped'> {
  if (getCliInteractionMode() !== 'plan') return 'skipped';
  const asker = getCliUserQuestionAsker();
  if (!asker) return 'unavailable';
  const plan = controller.getPlan(planId);
  const goal = plan?.goal ? plan.goal.slice(0, 160) : planId;
  const steps = plan?.steps?.length ?? 0;
  const prompt = [
    `Approve plan ${planId} and leave plan mode to begin implementation?`,
    `Goal: ${goal}`,
    steps > 0 ? `Steps: ${steps}` : undefined,
    'Answer y/yes to approve, or anything else to keep planning.',
  ]
    .filter(Boolean)
    .join('\n');
  let answer = '';
  try {
    answer = await asker(prompt, abortSignal);
  } catch {
    return 'declined';
  }
  if (abortSignal?.aborted) return 'declined';
  return isAffirmativePlanApproval(answer) ? 'approved' : 'declined';
}


export function resetPlanControllerForTests(): void {
  resetPlanControllerStoreForTests();
}

/**
 * 供客观验证器 hook 读取当前活跃 plan(只读,D10 解 A:按 PlanStep.expectedAccept
 * 查契约)。不暴露整个 controller,只暴露 plan 查询。无活跃 plan 返回 null。
 * hook 收到工具调用时,若有 plan + currentStep.expectedAccept → 按其引用的
 * skill 契约验收(优先于解 C 的 tool 反查)。
 */
export function getActivePlanForHook(): Plan | null {
  return getSharedPlanController().getActivePlan();
}






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
    async execute(input, ctx) {
      try {
        const controller = ctx.sessionKey
          ? getPlanController(ctx.sessionKey)
          : getSharedPlanController();

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
              lines.push('');
              lines.push('Issues:');
              for (const issue of result.issues) {
                const parts = issue.split(' — ');
                if (parts.length > 1) {
                  lines.push(`  - ${parts[0]}`);
                  lines.push(`    → ${parts.slice(1).join(' — ')}`);
                } else {
                  lines.push(`  - ${issue}`);
                }
              }
              lines.push('');
              lines.push('Next steps:');
              lines.push('1. Address all issues listed above');
              lines.push('2. Use plan action="format" to review the current plan');
              lines.push('3. Use plan action="review" again after fixes');
            }
            if (result.suggestions.length > 0) {
              lines.push('');
              lines.push('Suggestions:');
              for (const s of result.suggestions) lines.push(`  - ${s}`);
            }
            if (result.approved && !result.issues.length) {
              lines.push('');
              lines.push('Plan is valid and ready for execution: plan action="approve" planId=' + input.planId);
            }
            return lines.join('\n');
          }

          case 'approve': {
            if (!input.planId) return 'Error: planId is required for approval.';
            const confirmation = await confirmPlanApprovalIfNeeded(
              controller,
              input.planId,
              ctx.abortSignal,
            );
            if (confirmation === 'declined') {
              return (
                `Plan ${input.planId} was not approved. Staying in plan mode — continue refining with plan action="format"/"review", ` +
                `or ask the user again when ready.`
              );
            }
            const ok = controller.approvePlan(input.planId);
            if (!ok) return `Error: could not approve plan ${input.planId}.`;
            if (ctx.sessionKey) setActivePlanId(ctx.sessionKey, input.planId);
            // Claude ExitPlanMode parity (light): approving a plan is the user's
            // go-ahead to leave read-only planning and begin execution. If the
            // session is still in interactionMode=plan, drop to default so
            // subsequent mutations are not blocked by the plan-mode gate.
            const leftPlanMode = leavePlanModeForExecution();
            const confirmedNote =
              confirmation === 'approved'
                ? ' User confirmed leaving plan mode.'
                : confirmation === 'unavailable'
                  ? ' (no interactive confirm available; approved in non-interactive plan mode)'
                  : '';
            return leftPlanMode
              ? `Plan ${input.planId} approved.${confirmedNote} Left plan mode → default (mutations allowed). Next: plan action="start" planId=${input.planId}, then implement step by step.`
              : `Plan ${input.planId} approved.${confirmedNote} Next: plan action="start" planId=${input.planId}, then implement step by step.`;
          }

          case 'start': {
            if (!input.planId) return 'Error: planId is required to start execution.';
            const ok = controller.startExecution(input.planId);
            if (!ok) return `Error: could not start plan ${input.planId}. Ensure it is approved.`;
            if (ctx.sessionKey) setActivePlanId(ctx.sessionKey, input.planId);

            const leftPlanMode = leavePlanModeForExecution();
            const plan = controller.getPlan(input.planId);
            const modeNote = leftPlanMode
              ? 'Left plan mode → default (mutations allowed).\n\n'
              : '';
            return plan
              ? `${modeNote}Plan execution started.\n\n${PlanExecuteController.formatPlan(plan)}`
              : `${modeNote}Plan ${input.planId} execution started.`;
          }

          case 'cancel': {
            if (!input.planId) return 'Error: planId is required to cancel.';
            const ok = controller.cancelPlan(input.planId);
            return ok
              ? `Plan ${input.planId} cancelled.`
              : `Error: could not cancel plan ${input.planId}.`;
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
            if (state.isExecuting) {
              lines.push(`Current step: ${state.currentStep}`);
            }
            if (state.lastError) {
              lines.push('');
              lines.push(`Last error: ${state.lastError}`);
              lines.push('');
              lines.push('Recovery options:');
              lines.push('1. Fix the underlying issue and retry the current step');
              lines.push('2. Skip the failed step with plan_step action="skip"');
              lines.push('3. Cancel the plan and review with plan action="review"');
            }
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
    async execute(input, ctx) {
      try {
        const controller = ctx.sessionKey
          ? getPlanController(ctx.sessionKey)
          : getSharedPlanController();

        switch (input.action) {
          case 'complete': {
            const ok = controller.completeStep(
              input.planId,
              input.stepNumber,
              input.actualOutput,
              input.actualTools
            );
            if (!ok)
              return `Error: could not complete step ${input.stepNumber} in plan ${input.planId}.`;

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
            if (!ok)
              return `Error: could not skip step ${input.stepNumber} in plan ${input.planId}.`;

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






export const planTool: Tool<PlanToolInput> = createPlanTool();






export const planStepTool: Tool<PlanStepToolInput> = createPlanStepTool();
