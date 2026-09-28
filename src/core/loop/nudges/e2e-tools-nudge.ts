/**
 * E2eToolsNudge — mid-run reminder when the user asked to run e2e/playwright/
 * cypress but no matching e2e exec (or run_tests) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedE2eCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const E2E_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type E2eToolsNudgeRequest = NudgeRequest;
export type E2eToolsNudgeResult = NudgeResult;

export const evaluateE2eToolsNudge = defineToolsNudge({
  userRe: /(?:\be2e\b|\bplaywright\b|\bcypress\b|\bend[- ]to[- ]end\b|端到端|跑 e2e|跑一下 e2e)/iu,
  actionRe: /(?:run|execute|please|now|帮我|请|现在|跑)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.run_tests ?? 0) > 0 || (toolCallsByName.verify_fix ?? 0) > 0) return true;
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\bplaywright\b/i.test(cmd) ||
        /\bcypress\b/i.test(cmd) ||
        /\bpuppeteer\b/i.test(cmd) ||
        /\be2e\b/i.test(cmd) ||
        /\bnpm run (?:e2e|test:e2e)\b|\bpnpm (?:run )?(?:e2e|test:e2e)\b|\byarn (?:e2e|test:e2e)\b/i.test(
          cmd
        )
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to run e2e/playwright/cypress, and tools have already run without a matching e2e command ' +
    'or `run_tests`/`verify_fix`. Run the real e2e suite via `exec`/`run_tests` and report its output, ' +
    'or clearly say e2e was not run. Do not invent e2e results.',
});
