/**
 * PermissionRequest runs immediately before the user is asked to approve a
 * tool. Deny (exit policy or `{decision:deny|block}`) skips the prompt.
 * Allow is ignored, so the user is still asked.
 *
 * The approval policy module is frozen, so this wraps the asker that policy
 * calls rather than editing it. Headless runs that never ask are unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { stripVTControlCharacters } from 'node:util';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import { knownSecretPrefixCut } from '../safety/known-secrets.js';
import { redactEgress } from '../safety/tool-output-redact.js';
import type { AskUser } from './approval.js';
import type { CliApprovalViewAsker } from './approval-view.js';
import { isZhLocale } from './cli-locale.js';
import { hookEventZhName } from './hook-event-names.js';
import { sanitizeTextForTerminal } from './terminal-text.js';

const pending = new AsyncLocalStorage<{
  request: ToolApprovalRequest;
  denialReason?: string;
}>();

export function runWithApprovalRequest<T>(
  request: ToolApprovalRequest,
  fn: () => Promise<T>
): Promise<T> {
  return pending.run({ request }, fn);
}

/** Preserve a PermissionRequest denial even though UI askers answer with `n`. */
export function runWithApprovalDecision(
  request: ToolApprovalRequest,
  fn: () => Promise<ToolApprovalDecision>
): Promise<ToolApprovalDecision> {
  return runWithApprovalRequest(request, async () => {
    const decision = await fn();
    const reason = pending.getStore()?.denialReason;
    return reason ? { approved: false, reason } : decision;
  });
}

export type PermissionRequestRunner = (
  request: ToolApprovalRequest
) => Promise<{ denied: boolean; reason?: string }>;

let runner: PermissionRequestRunner | undefined;

export function setPermissionRequestRunner(next?: PermissionRequestRunner): void {
  runner = next;
}

async function denial(): Promise<string | undefined> {
  const scope = pending.getStore();
  if (!scope || !runner) return undefined;
  const result = await runner(scope.request);
  if (!result.denied) return undefined;
  // O91: the zh fallback names the hook in Chinese; en keeps the event id.
  const prefix = isZhLocale()
    ? `已拦截：${hookEventZhName('PermissionRequest')}钩子`
    : 'Blocked by PermissionRequest hook';
  const cleanDetail = sanitizeTextForTerminal(stripVTControlCharacters(result.reason ?? ''), {
    breakLongTokens: false,
  }).trim();
  const cut = knownSecretPrefixCut(cleanDetail);
  const detail = `${redactEgress(cleanDetail.slice(0, cut))}${cut < cleanDetail.length ? '[REDACTED]' : ''}`;
  const reason = !detail
    ? prefix
    : /^\s*(?:已拦截[：:]\s*)?(?:Blocked by PermissionRequest hook\b|权限请求时钩子)/i.test(detail)
      ? detail
      : `${prefix}: ${detail}`;
  scope.denialReason = reason;
  return reason;
}

export function wrapApprovalAsker(asker: AskUser): AskUser {
  return async (question, signal, dialog) => {
    const reason = await denial();
    if (reason) {
      process.stderr.write(`[hooks] ${reason}\n`);
      return 'n';
    }
    return asker(question, signal, dialog);
  };
}

export function wrapApprovalViewAsker(asker: CliApprovalViewAsker): CliApprovalViewAsker {
  return async (view, signal) => {
    const reason = await denial();
    if (reason) {
      process.stderr.write(`[hooks] ${reason}\n`);
      return 'n';
    }
    return asker(view, signal);
  };
}
