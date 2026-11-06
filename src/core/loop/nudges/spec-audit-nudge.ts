/**
 * SpecAuditNudge — when the request names documentation/spec requirements and
 * tools have run, force an authority audit before source edits continue.
 * Soft: max 1 fire. A SPEC-AUDIT.md write satisfies it.
 */

import type { NudgeMessage } from '../nudge-helpers.js';

export const SPEC_AUDIT_NUDGE_MAX_ATTEMPTS = 1;

// B187: cite-as-authority, not any mention of a doc. The old trigger fired on a
// bare "文档/说明/需求" and turned ordinary tasks into SPEC-AUDIT detours.
const SPEC_AUDIT_RE =
  /(?:\bspec(?:ification)?\b|\bdesign doc\b|\brequirements?\b|\blocked tests?\b|\bcomment says\b|\b(?:according to|per|follows?|from) (?:the )?(?:docs?|documentation|readme)\b|\b(?:docs?|documentation|readme) (?:says?|require|requires|specifies|mandates)\b|文档(?:里)?(?:说|要求|规定)|需求(?:里)?(?:说|要求|规定)|注释(?:里)?(?:说|要求|规定))/iu;

export interface SpecAuditNudgeRequest {
  messages: NudgeMessage[] | undefined;
  userText: string;
  totalToolCalls: number;
  attempts: number;
}

function toolUseBlocks(messages: NudgeMessage[] | undefined): Array<{
  name?: string;
  input?: unknown;
}> {
  const out: Array<{ name?: string; input?: unknown }> = [];
  for (const message of messages ?? []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const candidate = block as { type?: string; name?: string; input?: unknown };
      if (candidate?.type === 'tool_use') out.push(candidate);
    }
  }
  return out;
}

function specAuditWritten(messages: NudgeMessage[] | undefined): boolean {
  return toolUseBlocks(messages).some((call) => {
    if (call.name !== 'write_file' && call.name !== 'edit_file') return false;
    const input = call.input;
    if (!input || typeof input !== 'object') return false;
    const path = (input as Record<string, unknown>).path;
    return typeof path === 'string' && path.replaceAll('\\', '/').toLowerCase() === 'spec-audit.md';
  });
}

export type SpecAuditNudgeResult = { fire: false } | { fire: true; correction: string };

export function evaluateSpecAuditNudge(request: SpecAuditNudgeRequest): SpecAuditNudgeResult {
  if (request.attempts >= SPEC_AUDIT_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (!SPEC_AUDIT_RE.test(request.userText || '')) return { fire: false };
  if (specAuditWritten(request.messages)) return { fire: false };
  return {
    fire: true,
    correction:
      '[System] This request cites documentation/spec/requirements as an authority. Before another source edit: ' +
      'compare the task text, docs/comments, and locked tests, then choose the authority explicitly. ' +
      'If the cited authority is missing from the workspace, do NOT write SPEC-AUDIT.md: ask the user for the exact ' +
      'doc path or text in one short question and stop. Only if the docs exist and conflict with the task or are stale, ' +
      'write SPEC-AUDIT.md and restore any premature source/doc edit. Keep the whole check to one or two sentences.',
  };
}
