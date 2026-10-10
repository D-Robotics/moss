import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { TaskVerdict } from './verdict.js';

interface AcceptanceScope {
  workspaceDir: string;
  committed?: TaskVerdict;
}
const scopes = new AsyncLocalStorage<AcceptanceScope>();
const workspaceKey = (workspaceDir: string): string => {
  const resolved = path.resolve(workspaceDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Only the native provider calls this after its real persistence barriers. */
export function noteCommittedAcceptance(workspaceDir: string, verdict: TaskVerdict): void {
  const scope = scopes.getStore();
  if (scope?.workspaceDir === workspaceKey(workspaceDir)) scope.committed = verdict;
}

/** Each tool/child owns its scope; a child's commit cannot stop its parent. */
export async function inAcceptanceScope<T>(
  workspaceDir: string,
  action: () => Promise<T>
): Promise<{ value: T; committed?: TaskVerdict }> {
  const scope: AcceptanceScope = { workspaceDir: workspaceKey(workspaceDir) };
  const value = await scopes.run(scope, action);
  return { value, ...(scope.committed ? { committed: scope.committed } : {}) };
}
