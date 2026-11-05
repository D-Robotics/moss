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
import crypto from 'node:crypto';
import type { Tool } from '../core/tools/tool-types.js';

interface ExitPlanInput {
  summary?: string;
}

export const exitPlanTool: Tool<ExitPlanInput> = {
  name: 'exit_plan',
  description:
    'Call when a read-only plan is ready for the user to approve. ' +
    'This does not edit files and does not switch modes by itself: after it, wait for the user, ' +
    'then stop unless they ask for work. Not for asking a clarifying question (ask_user_question).',
  metadata: {
    leanDescription:
      'Call when a read-only plan is ready for approval; it edits nothing and switches no mode. Then wait for the user and stop unless they ask for work.',
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
    // Version the plan at submission time. The approval dialog echoes the same
    // fingerprint, so "approved" names a specific plan instead of whatever the
    // model writes next (Claude Code binds plan approval to the request id; text
    // has no id, so the hash is the closest honest equivalent).
    const version = crypto.createHash('sha256').update(summary, 'utf8').digest('hex').slice(0, 12);
    return (
      `Plan submitted for approval (version ${version}). Wait for the user before editing files.\n` +
      `The approval applies to this version; if the plan changes materially, ask again.\n` +
      summary
    );
  },
};
