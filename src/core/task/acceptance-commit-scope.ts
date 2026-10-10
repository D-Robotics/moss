import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { TaskVerdict } from './verdict.js';

interface AcceptanceScope {
  workspaceDir: string;
  committed?: TaskVerdict;
  settlements: Promise<void>[];
  dispatchOpen: boolean;
}
const nativeSettlements = new AsyncLocalStorage<{
  workspaceDir: string;
  settled: Promise<void>;
  registered: boolean;
}>();
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
  const scope: AcceptanceScope = {
    workspaceDir: workspaceKey(workspaceDir),
    settlements: [],
    dispatchOpen: true,
  };
  let value: T;
  try {
    value = await scopes.run(scope, action);
  } finally {
    scope.dispatchOpen = false;
  }
  await Promise.all(scope.settlements);
  return { value, ...(scope.committed ? { committed: scope.committed } : {}) };
}

/** Closed tools cannot start writes; only an already dispatched commit may settle. */
export function assertTaskAppendScopeOpen(workspaceDir: string, evidence = false): void {
  const key = workspaceKey(workspaceDir);
  const scope = scopes.getStore();
  const native = nativeSettlements.getStore();
  if (
    scope?.workspaceDir === key &&
    !scope.dispatchOpen &&
    (evidence || native?.workspaceDir !== key || !native.registered)
  ) {
    throw new Error('tool execution ended before native acceptance commit dispatch');
  }
}

/** Register only native persistence already dispatched inside the workspace lock. */
export function acceptanceAppendDispatched(workspaceDir: string): void {
  const native = nativeSettlements.getStore();
  const scope = scopes.getStore();
  if (!native || native.registered || native.workspaceDir !== workspaceKey(workspaceDir)) return;
  assertTaskAppendScopeOpen(workspaceDir);
  native.registered = true;
  if (scope?.workspaceDir === native.workspaceDir) scope.settlements.push(native.settled);
}

export async function inNativeAcceptanceSettlement<T>(
  workspaceDir: string,
  action: () => Promise<T>
): Promise<T> {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    return await nativeSettlements.run(
      { workspaceDir: workspaceKey(workspaceDir), settled, registered: false },
      action
    );
  } finally {
    finish();
  }
}
