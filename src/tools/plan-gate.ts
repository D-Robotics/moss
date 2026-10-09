/**
 * Plan-mode approval gate.
 *
 * Default off (`MOSS_PLAN_GATE` unset). The A/B in `bench:ab plan-gate` is the
 * only path that may justify turning it on; a score inside the noise band
 * keeps the default off.
 */
import type { Tool } from '../core/tools/tool-types.js';

export function planGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOSS_PLAN_GATE === '1';
}

interface ExitPlanInput {
  summary?: string;
}

export const exitPlanTool: Tool<ExitPlanInput> = {
  name: 'exit_plan',
  description:
    'Call when a read-only plan is ready for the user to approve. ' +
    'This does not edit files. If the plan gate is off, the plan stands as the answer.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
    requiresApproval: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One-paragraph summary of the plan the user would approve.',
      },
    },
    required: ['summary'],
  },
  async execute(input): Promise<string> {
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) return 'Error: exit_plan requires a summary of the plan.';
    if (!planGateEnabled()) {
      return (
        'Plan gate is off (MOSS_PLAN_GATE is not 1). The plan stands as the answer; ' +
        'do not wait for an approval dialog. Summary recorded:\n' +
        summary
      );
    }
    return (
      'Plan submitted for approval. Wait for the user before editing files.\n' + summary
    );
  },
};
