import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { TaskVerdict } from './verdict.js';
import {
  assertTaskExecutionCurrent,
  sealTaskAcceptanceSettlement,
  withTaskAcceptanceSettlement,
} from './task-execution-guard.js';

interface AcceptanceScope {
  workspaceDir: string;
  committed?: TaskVerdict;
  settlements: Promise<void>[];
  dispatchOpen: boolean;
}
const nativeSettlements = new AsyncLocalStorage<{
  workspaceDir: string;
  taskId?: string;
  settled: Promise<void>;
  registered: boolean;
}>();
const pendingPassSettlements = new Map<string, Set<object>>();
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
  assertTaskExecutionCurrent();
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
export function acceptanceAppendDispatched(workspaceDir: string, passed = false): void {
  const native = nativeSettlements.getStore();
  const scope = scopes.getStore();
  if (!native || native.workspaceDir !== workspaceKey(workspaceDir)) return;
  assertTaskAppendScopeOpen(workspaceDir);
  if (passed) {
    sealTaskAcceptanceSettlement();
    if (native.taskId) {
      const key = `${native.workspaceDir}\0${native.taskId}`;
      const pending = pendingPassSettlements.get(key) ?? new Set<object>();
      pending.add(native);
      pendingPassSettlements.set(key, pending);
    }
  }
  if (native.registered) return;
  native.registered = true;
  if (scope?.workspaceDir === native.workspaceDir) scope.settlements.push(native.settled);
}

export async function inNativeAcceptanceSettlement<T>(
  workspaceDir: string,
  action: () => Promise<T>,
  taskId?: string
): Promise<T> {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const native = {
    workspaceDir: workspaceKey(workspaceDir),
    taskId,
    settled,
    registered: false,
  };
  try {
    return await nativeSettlements.run(native, () => withTaskAcceptanceSettlement(action));
  } finally {
    if (taskId) {
      const key = `${native.workspaceDir}\0${taskId}`;
      const pending = pendingPassSettlements.get(key);
      pending?.delete(native);
      if (pending?.size === 0) pendingPassSettlements.delete(key);
    }
    finish();
  }
}

/** A correction cannot project into a task whose PASS is already being settled. */
export function isTaskAcceptanceSettling(workspaceDir: string, taskId: string): boolean {
  return (pendingPassSettlements.get(`${workspaceKey(workspaceDir)}\0${taskId}`)?.size ?? 0) > 0;
}
