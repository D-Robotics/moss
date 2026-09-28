/**
 * MutationFuzzToolsNudge — mid-run reminder when the user asked for mutation
 * or fuzz tests but no matching exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMutationFuzzCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const MUTATION_FUZZ_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type MutationFuzzToolsNudgeRequest = NudgeRequest;
export type MutationFuzzToolsNudgeResult = NudgeResult;

export const evaluateMutationFuzzToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bmutation tests?\b|\bfuzz tests?\b|\bstryker\b|\bcargo fuzz\b|\bmutmut\b|\bpitest\b|变异测试|跑 fuzz)/iu,
  actionRe: /(?:run|please|now|帮我|请|现在|跑)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.run_tests ?? 0) > 0 || (toolCallsByName.verify_fix ?? 0) > 0) return true;
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
  },
  correction:
    '[System] The user asked for mutation or fuzz tests, and tools have already run without a matching command ' +
    '(`stryker`, `cargo fuzz`, `mutmut`, `npm run test:mutation`, etc.) or `run_tests`/`verify_fix`. ' +
    'Run the real suite and report its output, or clearly say it was not run. ' +
    'Do not invent mutation/fuzz results.',
});
