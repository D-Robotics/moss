/**
 * SmokeLoadToolsNudge — mid-run reminder when the user asked for smoke/load/perf
 * tests but no matching smoke/load exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedSmokeLoadCompletionGate.
 */

export const SMOKE_LOAD_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const SMOKE_LOAD_USER_RE =
  /(?:\bsmoke tests?\b|\bload tests?\b|\bperf(?:ormance)? tests?\b|\bk6\b|\bartillery\b|\bwrk\b|冒烟测试|压测|跑冒烟)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface SmokeLoadToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type SmokeLoadToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawSmokeLoadEvidence(
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
        /\bsmoke\b/i.test(cmd) ||
        /\b(?:k6|artillery|wrk|ab|hey|vegeta|locust)\b/i.test(cmd) ||
        /\bnpm run (?:smoke|test:smoke|load|perf)\b|\bpnpm (?:run )?(?:smoke|test:smoke|load|perf)\b|\byarn (?:smoke|test:smoke|load|perf)\b/i.test(
          cmd,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateSmokeLoadToolsNudge(
  request: SmokeLoadToolsNudgeRequest,
): SmokeLoadToolsNudgeResult {
  if (request.attempts >= SMOKE_LOAD_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawSmokeLoadEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !SMOKE_LOAD_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|please|now|帮我|请|现在|跑)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for smoke/load/perf tests, and tools have already run without a matching smoke/load command ' +
      '(`npm run smoke`, `k6`, `artillery`, `wrk`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run the real smoke/load suite and report its output, or clearly say it was not run. ' +
      'Do not invent smoke/load results.',
  };
}
