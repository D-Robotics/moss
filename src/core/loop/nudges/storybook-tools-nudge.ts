/**
 * StorybookToolsNudge — mid-run reminder when the user asked to run/build
 * Storybook but no storybook-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedStorybookCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const STORYBOOK_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type StorybookToolsNudgeRequest = NudgeRequest;
export type StorybookToolsNudgeResult = NudgeResult;

export const evaluateStorybookToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bstorybook\b|\bbuild-storybook\b|\bnpm run storybook\b|启动 storybook|跑 storybook)/iu,
  actionRe: /(?:run|start|build|please|now|帮我|请|现在|启动|跑)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    // Background start may be storybook; still require storybook in command text when available.
    if (!messages?.length) return (toolCallsByName.exec_background ?? 0) > 0;
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bstorybook\b/i.test(cmd) ||
        /\bnpm run storybook\b|\bpnpm (?:run )?storybook\b|\byarn storybook\b/i.test(cmd) ||
        /\bnpm run build-storybook\b|\bpnpm (?:run )?build-storybook\b|\byarn build-storybook\b/i.test(
          cmd
        )
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to run or build Storybook, and tools have already run without a storybook-shaped command ' +
    '(`storybook`, `npm run storybook`, `build-storybook`, etc.). ' +
    'Run the real Storybook command via `exec`/`exec_background` and report its output, or clearly say Storybook was not run. ' +
    'Do not invent Storybook results.',
});
