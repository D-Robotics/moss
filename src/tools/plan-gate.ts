/**
 * Plan-mode approval tool.
 *
 * Cursor/Claude Code expose their exit-plan action as part of the plan mode
 * itself, not as an environment switch: `ExitPlanMode` exists whenever the
 * session is planning, and its absence otherwise is what tells the model that
 * "there is no approval dialog to wait for". Moss keeps the same contract:
 * `exit_plan` is always registered (SDK hosts may call it directly) and is
 * offered to the model only while the interaction mode is `plan`
 * (`toolVisibleForRun` + `PLAN_ONLY_TOOL_NAMES`). The old `MOSS_PLAN_GATE`
 * environment flag was an A/B harness artefact; it is retired because a mode
 * that exists must have its exit action.
 */
import type { Tool } from '../core/tools/tool-types.js';

interface ExitPlanInput {
  summary?: string;
}

export const exitPlanTool: Tool<ExitPlanInput> = {
  name: 'exit_plan',
  description:
    'Call when a read-only plan is ready for the user to approve. ' +
    'This does not edit files and does not switch modes by itself: after it, wait for the user, ' +
    'then stop unless they ask for work.',
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
    return 'Plan submitted for approval. Wait for the user before editing files.\n' + summary;
  },
};
