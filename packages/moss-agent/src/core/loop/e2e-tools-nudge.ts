/**
 * E2eToolsNudge — mid-run reminder when the user asked to run e2e/playwright/
 * cypress but no matching e2e exec (or run_tests) has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedE2eCompletionGate.
 */

export const E2E_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const E2E_USER_RE =
  /(?:\be2e\b|\bplaywright\b|\bcypress\b|\bend[- ]to[- ]end\b|端到端|跑 e2e|跑一下 e2e)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface E2eToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type E2eToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawE2eEvidence(
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
  }
  return false;
}

export function evaluateE2eToolsNudge(request: E2eToolsNudgeRequest): E2eToolsNudgeResult {
  if (request.attempts >= E2E_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawE2eEvidence(request.toolCallsByName, request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !E2E_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|execute|please|now|帮我|请|现在|跑)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked to run e2e/playwright/cypress, and tools have already run without a matching e2e command ' +
      'or `run_tests`/`verify_fix`. Run the real e2e suite via `exec`/`run_tests` and report its output, ' +
      'or clearly say e2e was not run. Do not invent e2e results.',
  };
}
