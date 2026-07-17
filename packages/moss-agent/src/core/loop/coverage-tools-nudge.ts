/**
 * CoverageToolsNudge — mid-run reminder when the user asked for coverage
 * but no coverage-shaped exec (or run_tests/verify_fix) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedCoverageCompletionGate.
 */

export const COVERAGE_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const COVERAGE_USER_RE =
  /(?:\bcoverage\b|\bnyc\b|\bc8\b|\bistanbul\b|--coverage|覆盖率|跑覆盖率)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface CoverageToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type CoverageToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawCoverageEvidence(
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
        /\bcoverage\b/i.test(cmd) ||
        /\b(?:nyc|c8|istanbul)\b/i.test(cmd) ||
        /\b(?:jest|vitest)\b[^\n]*--coverage\b/i.test(cmd) ||
        /\bnpm run (?:test:)?coverage\b|\bpnpm (?:run )?(?:test:)?coverage\b|\byarn (?:test:)?coverage\b/i.test(
          cmd,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateCoverageToolsNudge(
  request: CoverageToolsNudgeRequest,
): CoverageToolsNudgeResult {
  if (request.attempts >= COVERAGE_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawCoverageEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !COVERAGE_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|measure|collect|please|now|帮我|请|现在|跑)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for test coverage, and tools have already run without a coverage-shaped command ' +
      '(`--coverage`, `c8`, `nyc`, `npm run coverage`, etc.) or `run_tests`/`verify_fix`. ' +
      'Run real coverage and report the numbers, or clearly say coverage was not measured. ' +
      'Do not invent coverage percentages.',
  };
}
