/**
 * MutationFuzzToolsNudge — mid-run reminder when the user asked for mutation
 * or fuzz tests but no matching exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMutationFuzzCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const MUTATION_FUZZ_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const MUTATION_FUZZ_USER_RE =
  /(?:\bmutation tests?\b|\bfuzz tests?\b|\bstryker\b|\bcargo fuzz\b|\bmutmut\b|\bpitest\b|变异测试|跑 fuzz)/iu;

const MUTATION_FUZZ_ACTION_RE = /(?:run|please|now|帮我|请|现在|跑)/iu;

export type MutationFuzzToolsNudgeRequest = NudgeRequest;
export type MutationFuzzToolsNudgeResult = NudgeResult;

function sawMutationFuzzEvidence(
  byName: Record<string, number>,
  messages: NudgeMessage[] | undefined
): boolean {
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return true;
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\bstryker\b/i.test(cmd) ||
      /\bmutmut\b/i.test(cmd) ||
      /\bpitest\b/i.test(cmd) ||
      /\bcargo\s+fuzz\b/i.test(cmd) ||
      /\bafl-fuzz\b/i.test(cmd) ||
      /\blibfuzzer\b/i.test(cmd) ||
      /\bnpm run (?:test:)?(?:mutation|fuzz)\b|\bpnpm (?:run )?(?:test:)?(?:mutation|fuzz)\b|\byarn (?:test:)?(?:mutation|fuzz)\b/i.test(
        cmd
      )
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateMutationFuzzToolsNudge(
  request: MutationFuzzToolsNudgeRequest
): MutationFuzzToolsNudgeResult {
  if (request.attempts >= MUTATION_FUZZ_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawMutationFuzzEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !MUTATION_FUZZ_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, MUTATION_FUZZ_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for mutation or fuzz tests, and tools have already run without a matching command ' +
      '(`stryker`, `cargo fuzz`, `mutmut`, `npm run test:mutation`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run the real suite and report its output, or clearly say it was not run. ' +
      'Do not invent mutation/fuzz results.',
  };
}
