/**
 * StorybookToolsNudge — mid-run reminder when the user asked to run/build
 * Storybook but no storybook-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedStorybookCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const STORYBOOK_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const STORYBOOK_USER_RE =
  /(?:\bstorybook\b|\bbuild-storybook\b|\bnpm run storybook\b|启动 storybook|跑 storybook)/iu;

const STORYBOOK_ACTION_RE = /(?:run|start|build|please|now|帮我|请|现在|启动|跑)/iu;

export type StorybookToolsNudgeRequest = NudgeRequest;
export type StorybookToolsNudgeResult = NudgeResult;

function sawStorybookExec(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined
): boolean {
  // Background start may be storybook; still require storybook in command text when available.
  if (!messages?.length) return (byName.exec_background ?? 0) > 0;
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
}

export function evaluateStorybookToolsNudge(
  request: StorybookToolsNudgeRequest
): StorybookToolsNudgeResult {
  if (request.attempts >= STORYBOOK_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawStorybookExec(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !STORYBOOK_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, STORYBOOK_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to run or build Storybook, and tools have already run without a storybook-shaped command ' +
      '(`storybook`, `npm run storybook`, `build-storybook`, etc.). ' +
      'Run the real Storybook command via `exec`/`exec_background` and report its output, or clearly say Storybook was not run. ' +
      'Do not invent Storybook results.',
  };
}
