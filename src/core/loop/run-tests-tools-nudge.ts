/**
 * RunTestsToolsNudge — mid-run reminder when the user explicitly asked to run
 * tests / the suite, but no verification tools have run yet.
 *
 * Unlike VerifyNudge (edit-pressure after surgical patches), this fires even
 * with zero edits when the user asked for tests. Soft: max 1 fire.
 * Pairs with evaluateInventedVerificationCompletionGate.
 */

import { collectExecCommands, sawVerifyTools } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const RUN_TESTS_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const RUN_TESTS_USER_RE =
  /(?:\brun (?:the )?tests?\b|\brunning tests?\b|\bnpm test\b|\bpnpm test\b|\byarn test\b|\bpytest\b|\bcargo test\b|\bgo test\b|跑测试|跑一下测试|执行测试|跑测试套件)/iu;

const SKIP_TESTS_USER_RE =
  /(?:不要跑测试|跳过测试|skip\s+tests?|no\s+tests?|only\s+(?:docs?|copy|文案))/iu;

export type RunTestsToolsNudgeRequest = NudgeRequest;
export type RunTestsToolsNudgeResult = NudgeResult;

function sawTestShapedExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\b(?:npm|pnpm|yarn)\s+test\b/i.test(cmd) ||
      /\b(?:pytest|cargo\s+test|go\s+test|vitest|jest|mocha)\b/i.test(cmd)
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateRunTestsToolsNudge(
  request: RunTestsToolsNudgeRequest
): RunTestsToolsNudgeResult {
  if (request.attempts >= RUN_TESTS_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };

  if (sawVerifyTools(request.toolCallsByName)) return { fire: false };
  if (sawTestShapedExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !RUN_TESTS_USER_RE.test(user)) return { fire: false };
  if (SKIP_TESTS_USER_RE.test(user)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to run tests, and tools have already run without `run_tests` / `verify_fix` / `code_diagnostics` ' +
      '(or a test-shaped `exec` such as `npm test`). ' +
      'Run the suite now and report the real output — do not invent pass/fail results.',
  };
}
