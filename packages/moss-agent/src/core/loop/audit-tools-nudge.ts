/**
 * AuditToolsNudge — mid-run reminder when the user asked for a security audit
 * but no audit-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedAuditCompletionGate.
 */

export const AUDIT_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const AUDIT_USER_RE =
  /(?:\bnpm audit\b|\bcargo audit\b|\bsnyk\b|\btrivy\b|\bsecurity audit\b|\bpip-audit\b|安全审计|跑 audit|漏洞扫描)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface AuditToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type AuditToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawAuditExec(
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
        /\b(?:npm|pnpm|yarn|bun)\s+audit\b/i.test(cmd) ||
        /\bcargo\s+audit\b/i.test(cmd) ||
        /\bpip-audit\b/i.test(cmd) ||
        /\bsnyk\s+test\b/i.test(cmd) ||
        /\bosv-scanner\b/i.test(cmd) ||
        /\btrivy\b/i.test(cmd) ||
        /\bnpm run audit\b/i.test(cmd)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateAuditToolsNudge(request: AuditToolsNudgeRequest): AuditToolsNudgeResult {
  if (request.attempts >= AUDIT_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawAuditExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !AUDIT_USER_RE.test(user)) return { fire: false };

  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|please|now|帮我|请|现在|跑|扫描)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked for a security audit, and tools have already run without an audit-shaped command ' +
      '(`npm audit`, `cargo audit`, `snyk test`, `trivy`, etc.). ' +
      'Run a real audit via `exec` and report its output, or clearly say no audit was run. ' +
      'Do not invent vulnerability scan results.',
  };
}
