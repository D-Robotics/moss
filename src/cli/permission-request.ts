/**
 * PermissionRequest runs immediately before the user is asked to approve a
 * tool. Deny (exit policy or `{decision:deny|block}`) skips the prompt.
 * Allow is ignored, so the user is still asked.
 *
 * The approval policy module is frozen, so this wraps the asker that policy
 * calls rather than editing it. Headless runs that never ask are unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { AskUser } from './approval.js';
import type { CliApprovalViewAsker } from './approval-view.js';
import { isZhLocale } from './cli-locale.js';
import { hookEventZhName } from './hook-event-names.js';

const pending = new AsyncLocalStorage<ToolApprovalRequest>();

export function runWithApprovalRequest<T>(
  request: ToolApprovalRequest,
  fn: () => Promise<T>
): Promise<T> {
  return pending.run(request, fn);
}

export type PermissionRequestRunner = (
  request: ToolApprovalRequest
) => Promise<{ denied: boolean; reason?: string }>;

let runner: PermissionRequestRunner | undefined;

export function setPermissionRequestRunner(next?: PermissionRequestRunner): void {
  runner = next;
}

async function denial(request = pending.getStore()): Promise<string | undefined> {
  if (!request || !runner) return undefined;
  const result = await runner(request);
  if (!result.denied) return undefined;
  // O91: the zh fallback names the hook in Chinese; en keeps the event id.
  return (
    result.reason ??
    (isZhLocale()
      ? `已拦截：${hookEventZhName('PermissionRequest')}钩子`
      : 'Blocked by PermissionRequest hook')
  );
}

/** Run the same veto on the post-hook arguments before delegated approval.
 * If the user is prompted afterwards, the wrapped asker need not run it twice. */
export async function afterPermissionRequestHook(
  request: ToolApprovalRequest,
  decide: () => Promise<ToolApprovalDecision>
): Promise<ToolApprovalDecision> {
  const reason = await denial(request);
  if (reason) return { approved: false, reason, denialClass: 'policy' };
  return pending.exit(decide);
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
