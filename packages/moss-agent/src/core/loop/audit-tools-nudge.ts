/**
 * AuditToolsNudge — mid-run reminder when the user asked for a security audit
 * but no audit-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedAuditCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const AUDIT_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const AUDIT_USER_RE =
  /(?:\bnpm audit\b|\bcargo audit\b|\bsnyk\b|\btrivy\b|\bsecurity audit\b|\bpip-audit\b|安全审计|跑 audit|漏洞扫描)/iu;

const AUDIT_ACTION_RE = /(?:run|please|now|帮我|请|现在|跑|扫描)/iu;

export type AuditToolsNudgeRequest = NudgeRequest;
export type AuditToolsNudgeResult = NudgeResult;

function sawAuditExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
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
  return false;
}

export function evaluateAuditToolsNudge(request: AuditToolsNudgeRequest): AuditToolsNudgeResult {
  if (request.attempts >= AUDIT_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawAuditExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !AUDIT_USER_RE.test(user)) return { fire: false };
  if (isConceptualQuestion(user, AUDIT_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked for a security audit, and tools have already run without an audit-shaped command ' +
      '(`npm audit`, `cargo audit`, `snyk test`, `trivy`, etc.). ' +
      'Run a real audit via `exec` and report its output, or clearly say no audit was run. ' +
      'Do not invent vulnerability scan results.',
  };
}
