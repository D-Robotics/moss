/**
 * MutationFuzzToolsNudge — mid-run reminder when the user asked for mutation
 * or fuzz tests but no matching exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedMutationFuzzCompletionGate.
 */

export const MUTATION_FUZZ_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const MUTATION_FUZZ_USER_RE =
  /(?:\bmutation tests?\b|\bfuzz tests?\b|\bstryker\b|\bcargo fuzz\b|\bmutmut\b|\bpitest\b|变异测试|跑 fuzz)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface MutationFuzzToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type MutationFuzzToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawMutationFuzzEvidence(
  byName: Record<string, number>,
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return true;
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
        /\bstryker\b/i.test(cmd) ||
        /\bmutmut\b/i.test(cmd) ||
        /\bpitest\b/i.test(cmd) ||
        /\bcargo\s+fuzz\b/i.test(cmd) ||
        /\bafl-fuzz\b/i.test(cmd) ||
        /\blibfuzzer\b/i.test(cmd) ||
        /\bnpm run (?:test:)?(?:mutation|fuzz)\b|\bpnpm (?:run )?(?:test:)?(?:mutation|fuzz)\b|\byarn (?:test:)?(?:mutation|fuzz)\b/i.test(
          cmd,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateMutationFuzzToolsNudge(
  request: MutationFuzzToolsNudgeRequest,
): MutationFuzzToolsNudgeResult {
  if (request.attempts >= MUTATION_FUZZ_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawMutationFuzzEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !MUTATION_FUZZ_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|please|now|帮我|请|现在|跑)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for mutation or fuzz tests, and tools have already run without a matching command ' +
      '(`stryker`, `cargo fuzz`, `mutmut`, `npm run test:mutation`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run the real suite and report its output, or clearly say it was not run. ' +
      'Do not invent mutation/fuzz results.',
  };
}
