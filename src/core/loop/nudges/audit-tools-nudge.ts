/**
 * AuditToolsNudge — mid-run reminder when the user asked for a security audit
 * but no audit-shaped exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedAuditCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const AUDIT_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type AuditToolsNudgeRequest = NudgeRequest;
export type AuditToolsNudgeResult = NudgeResult;

export const evaluateAuditToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bnpm audit\b|\bcargo audit\b|\bsnyk\b|\btrivy\b|\bsecurity audit\b|\bpip-audit\b|安全审计|跑 audit|漏洞扫描)/iu,
  actionRe: /(?:run|please|now|帮我|请|现在|跑|扫描)/iu,
  sawEvidence: ({ messages }) => {
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
  },
  correction:
    '[System] The user asked for a security audit, and tools have already run without an audit-shaped command ' +
    '(`npm audit`, `cargo audit`, `snyk test`, `trivy`, etc.). ' +
    'Run a real audit via `exec` and report its output, or clearly say no audit was run. ' +
    'Do not invent vulnerability scan results.',
});
