/**
 * FormatToolsNudge — mid-run reminder when the user asked to format the code
 * but no format-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedFormatCompletionGate.
 */

export const FORMAT_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const FORMAT_USER_RE =
  /(?:\bprettier\b|\beslint\s+--fix\b|\bformat (?:the )?(?:code|files|codebase)\b|\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b|格式化代码|跑 prettier|格式化一下)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface FormatToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type FormatToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawFormatExec(
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
        /\bprettier\b/i.test(cmd) ||
        /\beslint\b[^\n]*--fix\b/i.test(cmd) ||
        /\b(?:gofmt|rustfmt|black|ruff\s+format|clang-format)\b/i.test(cmd) ||
        /\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b/i.test(cmd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateFormatToolsNudge(
  request: FormatToolsNudgeRequest,
): FormatToolsNudgeResult {
  if (request.attempts >= FORMAT_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawFormatExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !FORMAT_USER_RE.test(user)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to format the code, and tools have already run without a format-shaped command ' +
      '(`prettier`, `eslint --fix`, `npm run format`, etc.). ' +
      'Run the real formatter via `exec` and report its output, or clearly say formatting was skipped. ' +
      'Do not invent format success.',
  };
}
