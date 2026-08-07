/**
 * E2eToolsNudge — mid-run reminder when the user asked to run e2e/playwright/
 * cypress but no matching e2e exec (or run_tests) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedE2eCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const E2E_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const E2E_USER_RE =
  /(?:\be2e\b|\bplaywright\b|\bcypress\b|\bend[- ]to[- ]end\b|端到端|跑 e2e|跑一下 e2e)/iu;

const E2E_ACTION_RE = /(?:run|execute|please|now|帮我|请|现在|跑)/iu;

export type E2eToolsNudgeRequest = NudgeRequest;
export type E2eToolsNudgeResult = NudgeResult;

function sawE2eEvidence(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined,
): boolean {
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return true;
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\bplaywright\b/i.test(cmd) ||
      /\bcypress\b/i.test(cmd) ||
      /\bpuppeteer\b/i.test(cmd) ||
      /\be2e\b/i.test(cmd) ||
      /\bnpm run (?:e2e|test:e2e)\b|\bpnpm (?:run )?(?:e2e|test:e2e)\b|\byarn (?:e2e|test:e2e)\b/i.test(
        cmd,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateE2eToolsNudge(request: E2eToolsNudgeRequest): E2eToolsNudgeResult {
  if (request.attempts >= E2E_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawE2eEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !E2E_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, E2E_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to run e2e/playwright/cypress, and tools have already run without a matching e2e command ' +
      'or `run_tests`/`verify_fix`. Run the real e2e suite via `exec`/`run_tests` and report its output, ' +
      'or clearly say e2e was not run. Do not invent e2e results.',
  };
}
