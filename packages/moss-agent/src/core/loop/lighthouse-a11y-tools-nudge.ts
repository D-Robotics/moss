/**
 * LighthouseA11yToolsNudge — mid-run reminder when the user asked for
 * lighthouse or accessibility (a11y) audits but no matching exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedLighthouseA11yCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const LIGHTHOUSE_A11Y_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const LIGHTHOUSE_A11Y_USER_RE =
  /(?:\blighthouse\b|\ba11y\b|\baccessibility\b|\baxe\b|\bpa11y\b|无障碍|跑 lighthouse)/iu;

const LIGHTHOUSE_A11Y_ACTION_RE = /(?:run|please|now|帮我|请|现在|跑|检测)/iu;

export type LighthouseA11yToolsNudgeRequest = NudgeRequest;
export type LighthouseA11yToolsNudgeResult = NudgeResult;

function sawLighthouseA11yExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\blighthouse\b/i.test(cmd) ||
      /\baxe\b/i.test(cmd) ||
      /\bpa11y\b/i.test(cmd) ||
      /\baccessibility\b/i.test(cmd) ||
      /\bnpm run (?:lighthouse|a11y|test:a11y)\b|\bpnpm (?:run )?(?:lighthouse|a11y|test:a11y)\b|\byarn (?:lighthouse|a11y|test:a11y)\b/i.test(
        cmd
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateLighthouseA11yToolsNudge(
  request: LighthouseA11yToolsNudgeRequest
): LighthouseA11yToolsNudgeResult {
  if (request.attempts >= LIGHTHOUSE_A11Y_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawLighthouseA11yExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !LIGHTHOUSE_A11Y_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, LIGHTHOUSE_A11Y_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for lighthouse or accessibility (a11y) checks, and tools have already run without a matching command ' +
      '(`lighthouse`, `axe`, `pa11y`, `npm run a11y`, etc.). ' +
      'Run the real audit via `exec` and report its output, or clearly say it was not run. ' +
      'Do not invent lighthouse scores or a11y pass results.',
  };
}
