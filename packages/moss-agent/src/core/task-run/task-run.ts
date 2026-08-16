/** Lifecycle state for one durable user task. @beta */
export type TaskRunStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Verification is separate from completion so model text cannot claim proof. @beta */
export type TaskRunVerification = 'unverified' | 'verified' | 'rejected';

/** Ordered facts used to derive a task-run snapshot. @beta */
export type TaskRunEventType =
  | 'run.created'
  | 'run.started'
  | 'tool.started'
  | 'tool.succeeded'
  | 'tool.failed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'run.verified'
  | 'run.rejected';

/** One immutable task-run fact. @beta */
export interface TaskRunEvent {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: TaskRunEventType;
  readonly time: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Current projection of one task. @beta */
export interface TaskRunSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: TaskRunStatus;
  readonly verification: TaskRunVerification;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestSeq: number;
  readonly evidenceCount: number;
}

/** Identity and optional display metadata for a new task run. @beta */
export interface CreateTaskRunInput {
  readonly id: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly time?: number;
}

/** One host-authored fact to append to an existing task run. @beta */
export interface AppendTaskRunEventInput {
  readonly id?: string;
  readonly type: Exclude<TaskRunEventType, 'run.created'>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly time?: number;
}
