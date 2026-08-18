import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorCode, MossError } from '../../errors.js';
import type { ExecutionStore } from '../../orchestration/index.js';
import type {
  AppendTaskRunEventInput,
  CreateTaskRunInput,
  TaskRunEvent,
  TaskRunSnapshot,
  TaskRunStatus,
  TaskRunVerification,
} from './task-run.js';

const TERMINAL = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

function project(events: readonly TaskRunEvent[]): TaskRunSnapshot {
  const first = events[0];
  let status: TaskRunStatus = 'created';
  let verification: TaskRunVerification = 'unverified';
  let evidenceCount = 0;
  for (const event of events) {
    if (event.type === 'run.started') status = 'running';
    if (event.type === 'run.completed') status = 'completed';
    if (event.type === 'run.failed') status = 'failed';
    if (event.type === 'run.cancelled') status = 'cancelled';
    if (event.type === 'run.interrupted') status = 'interrupted';
    if (event.type === 'run.verified') verification = 'verified';
    if (event.type === 'run.rejected') verification = 'rejected';
    if (event.type === 'tool.succeeded' || event.type === 'tool.failed') evidenceCount += 1;
  }
  return {
    id: first.runId,
    sessionId: first.sessionId,
    title: typeof first.data.title === 'string' ? first.data.title : 'Untitled task',
    status,
    verification,
    createdAt: first.time,
    updatedAt: events.at(-1)?.time ?? first.time,
    latestSeq: events.length,
    evidenceCount,
  };
}

/** Instance-owned append-only task history with optional JSONL durability. @beta */
export class TaskRunLedger {
  private readonly runs = new Map<string, TaskRunEvent[]>();
  private readonly eventIds = new Map<string, string>();

  constructor(
    private readonly filePath?: string,
    private readonly executionStore?: ExecutionStore
  ) {
    if (filePath) this.load(filePath);
  }

  create(input: CreateTaskRunInput): TaskRunSnapshot {
    if (this.runs.has(input.id)) return this.get(input.id)!;
    const event: TaskRunEvent = {
      id: `tre_${randomUUID()}`,
      runId: input.id,
      sessionId: input.sessionId,
      seq: 1,
      type: 'run.created',
      time: input.time ?? Date.now(),
      data: { title: input.title?.trim() || 'New task' },
    };
    this.runs.set(input.id, [event]);
    this.eventIds.set(event.id, input.id);
    this.persist(event);
    if (this.executionStore && !this.executionStore.load(input.id)) {
      this.executionStore.create({
        id: input.id,
        sessionId: input.sessionId,
        goal: input.title?.trim() || 'New task',
        nodes: [],
        now: event.time,
      });
    }
    return project([event]);
  }

  append(runId: string, input: AppendTaskRunEventInput): TaskRunSnapshot {
    const events = this.runs.get(runId);
    if (!events) throw this.invalid(`unknown task run "${runId}"`);
    const id = input.id ?? `tre_${randomUUID()}`;
    const existingRunId = this.eventIds.get(id);
    if (existingRunId === runId) return project(events);
    if (existingRunId) throw this.invalid(`task event "${id}" belongs to another run`);
    const current = project(events);
    if (
      TERMINAL.has(current.status) &&
      input.type !== 'run.verified' &&
      input.type !== 'run.rejected'
    )
      throw this.invalid(`task run "${runId}" is already ${current.status}`);
    if (input.type === 'run.started' && current.status !== 'created')
      throw this.invalid(`task run "${runId}" cannot start from ${current.status}`);
    if (input.type.startsWith('tool.') && current.status !== 'running')
      throw this.invalid(`task evidence requires a running task`);
    if (
      (input.type === 'run.verified' || input.type === 'run.rejected') &&
      current.status !== 'completed'
    )
      throw this.invalid(`only a completed task can receive a verification verdict`);
    if (
      (input.type === 'run.verified' || input.type === 'run.rejected') &&
      current.verification !== 'unverified'
    )
      throw this.invalid(`task run "${runId}" already has a verification verdict`);
    const event: TaskRunEvent = {
      id,
      runId,
      sessionId: current.sessionId,
      seq: events.length + 1,
      type: input.type,
      time: input.time ?? Date.now(),
      data: input.data ?? {},
    };
    events.push(event);
    this.eventIds.set(id, runId);
    this.persist(event);
    this.mirrorExecutionEvent(event);
    return project(events);
  }

  get(runId: string): TaskRunSnapshot | undefined {
    const events = this.runs.get(runId);
    return events ? project(events) : undefined;
  }

  events(runId: string, after = 0): readonly TaskRunEvent[] {
    return (this.runs.get(runId) ?? [])
      .filter((event) => event.seq > after)
      .map((event) => ({ ...event }));
  }

  list(): readonly TaskRunSnapshot[] {
    return [...this.runs.values()].map(project).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  recoverInterrupted(time = Date.now()): number {
    let recovered = 0;
    for (const snapshot of this.list()) {
      if (snapshot.status !== 'created' && snapshot.status !== 'running') continue;
      this.append(snapshot.id, {
        type: 'run.interrupted',
        time,
        data: { reason: 'host restarted' },
      });
      recovered += 1;
    }
    return recovered;
  }

  private persist(event: TaskRunEvent): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  private mirrorExecutionEvent(event: TaskRunEvent): void {
    const store = this.executionStore;
    let graph = store?.load(event.runId);
    if (!store || !graph) return;
    const append = (
      type: Parameters<ExecutionStore['append']>[1]['type'],
      data: Readonly<Record<string, unknown>> = {}
    ): void => {
      graph = store.append(event.runId, {
        id: `task-run-${event.id}-${type}`,
        expectedRevision: graph!.revision,
        type,
        time: event.time,
        data,
      });
    };
    if (event.type === 'run.started') append('graph.resumed');
    else if (event.type === 'run.failed') append('graph.failed', { source: 'task-run-v1' });
    else if (event.type === 'run.cancelled') append('graph.cancelled', { source: 'task-run-v1' });
    else if (event.type === 'run.interrupted') {
      append('graph.recovered', {
        recovery: {
          recoveredAt: event.time,
          requiresUserResume: true,
          interruptedNodeIds: [],
          blockedMutationNodeIds: [],
        },
      });
    } else if (event.type === 'tool.succeeded' || event.type === 'tool.failed') {
      const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : 'tool';
      append('evidence.recorded', {
        evidence: {
          id: `task-run-evidence-${event.id}`,
          kind: 'tool_result',
          summary: `${toolName} ${event.type === 'tool.succeeded' ? 'succeeded' : 'failed'}`,
          createdAt: event.time,
          metadata: { success: event.type === 'tool.succeeded', source: 'task-run-v1' },
        },
      });
    } else if (event.type === 'run.verified' || event.type === 'run.rejected') {
      const verdict = event.type === 'run.verified' ? 'verified' : 'rejected';
      append('verification.recorded', {
        verification: {
          verdict,
          evidenceIds: graph.evidence.map((evidence) => evidence.id),
          reasons: verdict === 'verified' ? [] : ['legacy verifier rejected the run'],
          verifiedAt: event.time,
        },
      });
      append(verdict === 'verified' ? 'graph.completed' : 'graph.failed', {
        source: 'task-run-v1-verdict',
      });
    }
    // run.completed intentionally does not complete the graph: a completion
    // claim remains pending until a verifier or CompletionArbiter binds evidence.
  }

  private load(filePath: string): void {
    let body = '';
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    let needsRepair = false;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      let event: TaskRunEvent;
      try {
        event = JSON.parse(line) as TaskRunEvent;
      } catch {
        needsRepair = true;
        break;
      }
      const events = this.runs.get(event.runId) ?? [];
      if (
        typeof event.id !== 'string' ||
        typeof event.runId !== 'string' ||
        typeof event.sessionId !== 'string' ||
        event.seq !== events.length + 1 ||
        this.eventIds.has(event.id)
      ) {
        needsRepair = true;
        break;
      }
      events.push(event);
      this.runs.set(event.runId, events);
      this.eventIds.set(event.id, event.runId);
    }
    if (needsRepair) {
      const valid = [...this.runs.values()]
        .flat()
        .map((event) => JSON.stringify(event))
        .join('\n');
      fs.writeFileSync(filePath, valid ? `${valid}\n` : '', { mode: 0o600 });
    }
  }

  private invalid(message: string): MossError {
    return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  }
}
