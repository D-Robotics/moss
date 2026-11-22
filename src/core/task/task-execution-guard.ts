import { AsyncLocalStorage } from 'node:async_hooks';
import { ErrorCode, MossError } from '../../errors.js';

const executionGuards = new AsyncLocalStorage<readonly (() => void)[]>();
const settlements = new AsyncLocalStorage<{ sealed: boolean }>();

export class TaskExecutionSupersededError extends MossError {
  constructor(
    message = 'Task execution was superseded by newer user input.',
    options?: { cause?: unknown }
  ) {
    super({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message,
      context: { reason: 'task_execution_superseded' },
      ...(options?.cause instanceof Error ? { cause: options.cause } : {}),
    });
    this.name = 'TaskExecutionSupersededError';
  }
}

export function isTaskExecutionSupersededError(error: unknown): boolean {
  return error instanceof TaskExecutionSupersededError;
}

/** Bind user-input and task-version checks to every task write in this execution. */
export function withTaskExecutionGuard<T>(assertCurrent: () => void, action: () => T): T {
  return executionGuards.run([...(executionGuards.getStore() ?? []), assertCurrent], () => {
    assertTaskExecutionCurrent();
    return action();
  });
}

export function assertTaskExecutionCurrent(): void {
  if (settlements.getStore()?.sealed) return;
  try {
    for (const assertCurrent of executionGuards.getStore() ?? []) assertCurrent();
  } catch (cause) {
    if (cause instanceof TaskExecutionSupersededError) throw cause;
    throw new TaskExecutionSupersededError(undefined, { cause });
  }
}

/** Only native acceptance may finish an already-dispatched PASS after new input. */
export function withTaskAcceptanceSettlement<T>(action: () => T): T {
  return settlements.run({ sealed: false }, action);
}

export function sealTaskAcceptanceSettlement(): void {
  const settlement = settlements.getStore();
  if (settlement) settlement.sealed = true;
}

/** Runtime bookkeeping may pause an obsolete execution without reopening its writes. */
export function inTaskExecutionControlScope<T>(action: () => T): T {
  return executionGuards.run([], action);
}
