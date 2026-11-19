import crypto from 'node:crypto';
import type {
  TaskIntentInput,
  TaskIntentReceipt,
  TaskIntentSnapshot,
  TurnDecision,
} from '../../contracts/task-intent.js';
import { ErrorCode, MossError } from '../../errors.js';
import {
  TaskExecutionSupersededError,
  isTaskExecutionSupersededError,
  withTaskExecutionGuard,
} from '../task/task-execution-guard.js';
import { applyTaskRevision } from '../task/task-revision.js';
import { appendTaskEvent, getTaskStateSnapshot } from '../task/task-store.js';
import { listTaskRecords } from '../task-runtime/artifacts.js';
import { type SessionInbox, type SessionInboxEntry } from './session-inbox.js';
import { applyIntentChanges, emptyTaskIntent, readTaskIntent } from './task-intent-state.js';

export interface TaskIntentBatch {
  snapshot: TaskIntentSnapshot;
  inputs: SessionInboxEntry[];
  taskRevision: number;
}

interface InboxPort {
  read(): SessionInbox;
  mutate<T>(operation: (inbox: SessionInbox) => T): T;
}

function pendingInputs(inbox: SessionInbox): SessionInboxEntry[] {
  return inbox
    .toEntries()
    .filter((entry) =>
      entry.intent ? ['pending', 'failed'].includes(entry.intent.status) : false
    );
}

function sameFields(a: TaskIntentSnapshot['state'], b: TaskIntentSnapshot['state']): boolean {
  return ['goal', 'target', 'executionSurface', 'constraints', 'responseRequirements'].every(
    (field) =>
      JSON.stringify(a[field as keyof typeof a]) === JSON.stringify(b[field as keyof typeof b])
  );
}

/** One journal for input receipt, effective intent, and retryable task projection. */
export class TaskIntentCoordinator {
  constructor(
    private readonly port: InboxPort,
    private readonly workspaceDir: string
  ) {}

  read(): TaskIntentSnapshot {
    return readTaskIntent(this.port.read().toEntries());
  }

  receipt(id: string): TaskIntentReceipt | undefined {
    const value = this.port
      .read()
      .toEntries()
      .find((entry) => entry.id === id)?.intent;
    if (!value) return undefined;
    return {
      status: value.status === 'projecting' ? 'pending' : value.status,
      ...(value.revision !== undefined || value.snapshot
        ? { revision: value.revision ?? value.snapshot?.revision }
        : {}),
    };
  }

  admit(
    input: TaskIntentInput,
    steering?: { runId: string; producer: Record<string, unknown> }
  ): SessionInboxEntry {
    if (!input.id.trim() || input.id.length > 240 || !input.text.trim()) {
      throw new MossError({
        code: ErrorCode.SESSION_PERSIST_FAILED,
        message: 'Invalid task input identity or text',
      });
    }
    return this.port.mutate((inbox) => {
      const previous = inbox.toEntries().find((entry) => entry.id === input.id);
      if (previous) {
        if (
          !previous.intent ||
          (previous.intent?.digest
            ? previous.intent.digest !==
              crypto.createHash('sha256').update(input.text).digest('hex')
            : previous.prompt !== input.text) ||
          (previous.intent.taskId && input.taskId && previous.intent.taskId !== input.taskId)
        ) {
          throw new MossError({
            code: ErrorCode.SESSION_PERSIST_FAILED,
            message: 'Task input identity conflicts with an existing input',
          });
        }
        if (!previous.intent.taskId && input.taskId && previous.intent.status === 'pending') {
          inbox.setIntent(previous.id, { ...previous.intent, taskId: input.taskId });
        }
        return previous;
      }
      const entry = inbox.admit({
        id: input.id,
        prompt: input.text,
        delivery: steering ? 'steer' : 'queue',
        metadata: steering ?? { intentOnly: true },
      });
      entry.intent = { status: 'pending', ...(input.taskId ? { taskId: input.taskId } : {}) };
      return entry;
    });
  }

  async capture(taskId?: string): Promise<TaskIntentBatch> {
    await this.recover();
    const inbox = this.port.read();
    const snapshot = readTaskIntent(inbox.toEntries());
    const inputs = structuredClone(pendingInputs(inbox));
    // A fresh host-unbound user turn must not revise the previous native task
    // implicitly, especially after it has completed. Engine turns carry taskId.
    const effectiveTaskId =
      taskId ??
      inputs.at(-1)?.intent?.taskId ??
      (inputs.length === 0 ? snapshot.taskId : undefined);
    if (!effectiveTaskId) delete snapshot.taskId;
    let taskRevision = 0;
    if (effectiveTaskId) {
      const task = await getTaskStateSnapshot(this.workspaceDir, effectiveTaskId);
      if (!task) throw new Error(`Task intent binding does not exist: ${effectiveTaskId}`);
      taskRevision = task.revision;
      if (snapshot.taskId !== effectiveTaskId) {
        const contract = (await listTaskRecords(this.workspaceDir, Number.MAX_SAFE_INTEGER)).find(
          (item) => item.taskId === effectiveTaskId
        );
        snapshot.state = {
          ...emptyTaskIntent().state,
          goal: task.goal,
          target: task.targetDeviceId ?? '',
          constraints: [...(contract?.constraints ?? [])],
        };
        snapshot.plan = [];
        snapshot.planId = '';
      }
      snapshot.taskId = effectiveTaskId;
    }
    // Any input admitted during awaited task reads is left for the next turn.
    return { snapshot, inputs, taskRevision };
  }

  assertCurrent(binding?: TaskIntentSnapshot, allowHold = false): void {
    const current = this.read();
    if (
      current.pending ||
      (binding &&
        (binding.revision !== current.revision ||
          binding.inputSeq !== current.inputSeq ||
          binding.planId !== current.planId)) ||
      (!allowHold && current.disposition !== 'execute')
    ) {
      throw new TaskExecutionSupersededError(
        'Task input changed or the current decision does not authorize execution'
      );
    }
  }

  async commit(batch: TaskIntentBatch, decision: TurnDecision): Promise<TaskIntentSnapshot> {
    if (
      decision.baseRevision !== batch.snapshot.revision ||
      decision.inputSeq !== batch.snapshot.inputSeq ||
      JSON.stringify(decision.messageIds) !== JSON.stringify(batch.inputs.map((entry) => entry.id))
    ) {
      throw new Error('turn_decision does not match the captured user input');
    }
    const state = applyIntentChanges(batch.snapshot.state, decision.changes, batch.inputs);
    if (!state.goal && batch.inputs.length > 0) {
      state.goal = batch.inputs[0]!.prompt;
      state.sources.goal = [{ messageId: batch.inputs[0]!.id, quote: batch.inputs[0]!.prompt }];
    }
    const changed = !sameFields(batch.snapshot.state, state);
    const snapshot: TaskIntentSnapshot = {
      ...batch.snapshot,
      state,
      revision: batch.snapshot.revision + (changed ? 1 : 0),
      processedSeq: decision.inputSeq,
      pending: false,
      disposition: decision.disposition,
      planId: decision.disposition === 'execute' ? crypto.randomUUID() : '',
      plan: [...decision.plan],
    };
    const lastId = batch.inputs.at(-1)?.id;
    if (!lastId) throw new Error('No pending user input to commit');
    this.port.mutate((inbox) => {
      const current = readTaskIntent(inbox.toEntries());
      if (
        current.revision !== batch.snapshot.revision ||
        current.inputSeq !== decision.inputSeq ||
        current.processedSeq !== batch.snapshot.processedSeq ||
        JSON.stringify(pendingInputs(inbox).map((entry) => entry.id)) !==
          JSON.stringify(decision.messageIds)
      ) {
        throw new TaskExecutionSupersededError('A newer user input superseded this response');
      }
      const last = inbox.toEntries().find((entry) => entry.id === lastId)!;
      // Publish the recovery journal before any asynchronous task projection.
      inbox.setIntent(lastId, {
        ...last.intent,
        status: 'projecting',
        snapshot,
        expectedTaskRevision: batch.taskRevision + (changed ? 1 : 0),
        ...(snapshot.taskId && changed
          ? {
              projection: {
                revisionId: `intent:${lastId}:${snapshot.revision}`,
                expectedRevision: batch.taskRevision,
                sourceMessageIds: decision.messageIds,
                changes: {
                  goal: state.goal,
                  ...(state.target ? { targetDeviceId: state.target } : {}),
                  constraints: [
                    ...state.constraints,
                    ...(state.executionSurface
                      ? [`Execution surface: ${state.executionSurface}`]
                      : []),
                    ...state.responseRequirements.map((item) => `Response requirement: ${item}`),
                  ],
                },
              },
            }
          : {}),
      });
    });
    await this.projectOrFail(lastId, decision.messageIds);
    return snapshot;
  }

  async recover(): Promise<void> {
    for (const entry of this.port.read().toEntries()) {
      if (entry.intent?.status === 'projecting') {
        const ids =
          entry.intent.projection?.sourceMessageIds ??
          this.port
            .read()
            .toEntries()
            .filter(
              (item) =>
                item.intent &&
                item.admittedSeq <= (entry.intent?.snapshot?.processedSeq ?? 0) &&
                item.intent.status === 'pending'
            )
            .map((item) => item.id);
        await this.projectOrFail(entry.id, [...new Set([...ids, entry.id])]);
      }
    }
  }

  private async projectOrFail(lastId: string, messageIds: string[]): Promise<void> {
    try {
      await this.finishProjection(lastId, messageIds);
    } catch (error) {
      if (
        error instanceof MossError &&
        !isTaskExecutionSupersededError(error) &&
        [
          ErrorCode.EXECUTION_STATE_INVALID,
          ErrorCode.EXECUTION_REVISION_CONFLICT,
          ErrorCode.USER_INPUT_INVALID,
        ].includes(error.code)
      ) {
        this.port.mutate((inbox) => {
          const entry = inbox.toEntries().find((item) => item.id === lastId);
          if (entry?.intent?.status === 'projecting')
            inbox.setIntent(lastId, { ...entry.intent, status: 'failed' });
        });
      }
      throw error;
    }
  }

  private async finishProjection(lastId: string, messageIds: string[]): Promise<void> {
    const entry = this.port
      .read()
      .toEntries()
      .find((item) => item.id === lastId);
    const intent = entry?.intent;
    const snapshot = intent?.snapshot;
    if (!intent || intent.status !== 'projecting' || !snapshot) return;
    if (snapshot.taskId) {
      const task = intent.projection
        ? await applyTaskRevision(this.workspaceDir, snapshot.taskId, intent.projection)
        : await getTaskStateSnapshot(this.workspaceDir, snapshot.taskId);
      if (!task) throw new Error('Task intent projection lost its native task');
      if (task.revision !== intent.expectedTaskRevision)
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: 'The native task changed while the intent was being projected',
        });
      const current = this.read();
      if (
        snapshot.disposition === 'execute' &&
        current.inputSeq === snapshot.inputSeq &&
        current.planId === snapshot.planId &&
        (!intent.projection || task.revision === intent.projection.expectedRevision + 1)
      ) {
        await withTaskExecutionGuard(
          () => {
            const latest = this.read();
            if (latest.inputSeq !== snapshot.inputSeq || latest.planId !== snapshot.planId) {
              throw new TaskExecutionSupersededError('A newer input superseded the projected plan');
            }
          },
          () =>
            appendTaskEvent(
              this.workspaceDir,
              snapshot.taskId!,
              task.needsReplan || ['draft', 'understanding', 'planning'].includes(task.phase)
                ? 'plan_ready'
                : 'plan_step_updated',
              {
                taskRevision: task.revision,
                steps: snapshot.plan.map((title, index) => ({
                  stepId: `${snapshot.planId}:${index}`,
                  title,
                  status: 'pending',
                })),
              }
            )
        );
      }
    }
    this.port.mutate((inbox) => {
      for (const item of inbox.toEntries()) {
        if (!messageIds.includes(item.id) || !item.intent) continue;
        inbox.setIntent(item.id, {
          ...item.intent,
          status: snapshot.disposition === 'clarify' ? 'needs_clarification' : 'committed',
          revision: snapshot.revision,
          ...(item.id === lastId ? { snapshot } : {}),
        });
        if (item.metadata?.intentOnly) inbox.promote(item.id);
      }
    });
  }
}
