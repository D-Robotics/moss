import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { TaskVerdict } from './verdict.js';

interface AcceptanceScope {
  workspaceDir: string;
  committed?: TaskVerdict;
  taskId?: string;
  parent?: AcceptanceScope;
  settlements: Promise<void>[];
  dispatchOpen: boolean;
}
const nativeSettlements = new AsyncLocalStorage<{
  workspaceDir: string;
  taskId: string;
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
  const current = scopes.getStore();
  const native = nativeSettlements.getStore();
  const key = workspaceKey(workspaceDir);
  for (let scope = current; scope; scope = scope.parent) {
    if (scope.workspaceDir !== key) continue;
    if (
      scope === current ||
      (scope.taskId === verdict.taskId &&
        (scope.dispatchOpen ||
          (native !== undefined && scope.settlements.includes(native.settled))))
    ) {
      scope.committed = verdict;
    }
  }
}

/** A child can settle only an explicitly matching parent task in the same workspace. */
export async function inAcceptanceScope<T>(
  workspaceDir: string,
  action: () => Promise<T>,
  taskId?: string
): Promise<{ value: T; committed?: TaskVerdict }> {
  const scope: AcceptanceScope = {
    workspaceDir: workspaceKey(workspaceDir),
    ...(taskId !== undefined ? { taskId } : {}),
    parent: scopes.getStore(),
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
  const current = scopes.getStore();
  if (!native || native.registered || native.workspaceDir !== workspaceKey(workspaceDir)) return;
  assertTaskAppendScopeOpen(workspaceDir);
  native.registered = true;
  for (let scope = current; scope; scope = scope.parent) {
    if (scope.workspaceDir !== native.workspaceDir) continue;
    if (scope === current || (scope.dispatchOpen && scope.taskId === native.taskId)) {
      scope.settlements.push(native.settled);
    }
  }
}

export async function inNativeAcceptanceSettlement<T>(
  workspaceDir: string,
  taskId: string,
  action: () => Promise<T>
): Promise<T> {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    return await nativeSettlements.run(
      { workspaceDir: workspaceKey(workspaceDir), taskId, settled, registered: false },
      action
    );
  } finally {
    finish();
  }
}
