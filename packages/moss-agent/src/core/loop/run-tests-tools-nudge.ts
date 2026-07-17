/**
 * RunTestsToolsNudge — mid-run reminder when the user explicitly asked to run
 * tests / the suite, but no verification tools have run yet.
 *
 * Unlike VerifyNudge (edit-pressure after surgical patches), this fires even
 * with zero edits when the user asked for tests. Soft: max 1 fire.
 * Pairs with evaluateInventedVerificationCompletionGate.
 */

export const RUN_TESTS_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

const RUN_TESTS_USER_RE =
  /(?:\brun (?:the )?tests?\b|\brunning tests?\b|\bnpm test\b|\bpnpm test\b|\byarn test\b|\bpytest\b|\bcargo test\b|\bgo test\b|跑测试|跑一下测试|执行测试|跑测试套件)/iu;

const SKIP_TESTS_USER_RE =
  /(?:不要跑测试|跳过测试|skip\s+tests?|no\s+tests?|only\s+(?:docs?|copy|文案))/iu;

export interface RunTestsToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type RunTestsToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function countBySet(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

function sawTestShapedExec(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
  if (!messages?.length) return false;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name || !EXEC_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const o = input as Record<string, unknown>;
      let cmd = '';
      for (const key of ['command', 'cmd', 'input'] as const) {
        if (typeof o[key] === 'string' && String(o[key]).trim()) {
          cmd = String(o[key]);
          break;
        }
      }
      if (
        /\b(?:npm|pnpm|yarn)\s+test\b/i.test(cmd) ||
        /\b(?:pytest|cargo\s+test|go\s+test|vitest|jest|mocha)\b/i.test(cmd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateRunTestsToolsNudge(
  request: RunTestsToolsNudgeRequest,
): RunTestsToolsNudgeResult {
  if (request.attempts >= RUN_TESTS_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };

  if (countBySet(request.toolCallsByName, VERIFY_TOOLS) > 0) return { fire: false };
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
