/**
 * LighthouseA11yToolsNudge — mid-run reminder when the user asked for
 * lighthouse or accessibility (a11y) audits but no matching exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedLighthouseA11yCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const LIGHTHOUSE_A11Y_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type LighthouseA11yToolsNudgeRequest = NudgeRequest;
export type LighthouseA11yToolsNudgeResult = NudgeResult;

export const evaluateLighthouseA11yToolsNudge = defineToolsNudge({
  userRe: /(?:\blighthouse\b|\ba11y\b|\baccessibility\b|\baxe\b|\bpa11y\b|无障碍|跑 lighthouse)/iu,
  actionRe: /(?:run|please|now|帮我|请|现在|跑|检测)/iu,
  sawEvidence: ({ messages }) => {
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
  },
  correction:
    '[System] The user asked for lighthouse or accessibility (a11y) checks, and tools have already run without a matching command ' +
    '(`lighthouse`, `axe`, `pa11y`, `npm run a11y`, etc.). ' +
    'Run the real audit via `exec` and report its output, or clearly say it was not run. ' +
    'Do not invent lighthouse scores or a11y pass results.',
});
