/**
 * PermissionRequest runs immediately before the user is asked to approve a
 * tool. Deny (exit policy or `{decision:deny|block}`) skips the prompt.
 * Allow is ignored, so the user is still asked.
 *
 * The approval policy module is frozen, so this wraps the asker that policy
 * calls rather than editing it. Headless runs that never ask are unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { AskUser } from './approval.js';
import type { CliApprovalViewAsker } from './approval-view.js';

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

async function denial(): Promise<string | undefined> {
  const request = pending.getStore();
  if (!request || !runner) return undefined;
  const result = await runner(request);
  if (!result.denied) return undefined;
  return result.reason ?? 'Blocked by PermissionRequest hook';
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
