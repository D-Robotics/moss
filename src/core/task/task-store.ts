/**
 * Task store (Task OS M2) — the single write path for task lifecycle state.
 * Contracts/evidence/verdicts keep flowing through the shared artifact IO
 * (core/task-runtime/artifacts.ts); lifecycle state is event-sourced into
 * .moss/task-events.jsonl and validated by the contract state machine, so a
 * phase can only move because a real event happened — never because the
 * model asserted it. Failures and repairs are first-class JSONL records.
 */
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireTaskArtifactWriteLock } from '../session/session-write-lock.js';
import path from 'node:path';

import { MossError, ErrorCode } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import type { AcceptanceVerdict, TaskContract } from '../../contracts/task.js';
import { latestAcceptanceVerdict } from '../../contracts/task.js';
import {
  nextTaskPhase,
  taskStatusView,
  deriveTaskOutcome,
  latestTaskFailureDetail,
  isTerminalTaskPhase,
} from '../../contracts/task-runtime.js';
import type {
  FailureRecord,
  RepairRecord,
  TaskEvent,
  TaskEventType,
  TaskPhase,
  TaskPlanStep,
  TaskStateSnapshot,
} from '../../contracts/task-runtime.js';
import { experienceEnabled, recordAcceptedExperience } from '../experience/experience-library.js';
import {
  appendJsonlFile,
  appendTaskRecord,
  listEvidenceRecords,
  listTaskRecords,
  readJsonlFile,
} from '../task-runtime/artifacts.js';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import { ensureDirectoryDurably } from '../session/jsonl-session-store.js';

const log = getRootLogger().child('task-store');

const EVENTS_FILE = 'task-events.jsonl';
const FAILURES_FILE = 'task-failures.jsonl';
const REPAIRS_FILE = 'task-repairs.jsonl';
const EVENT_LOCK_WAIT_MS = 5_000;
interface TaskLockScope {
  key: string;
  active: boolean;
  parent?: TaskLockScope;
}
const taskLockScope = new AsyncLocalStorage<TaskLockScope>();
function ownsTaskLock(key: string): boolean {
  for (let scope = taskLockScope.getStore(); scope; scope = scope.parent) {
    if (scope.active && scope.key === key) return true;
  }
  return false;
}

/** In-process queue so two writers in one process take the file lock in order. */
const taskEventWriteChains = new Map<string, Promise<unknown>>();

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function mossDir(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, '.moss');
  await ensureDirectoryDurably(dir);
  return dir;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  return readJsonlFile<T>(file);
}

async function appendJsonl(
  workspaceDir: string,
  name: string,
  record: unknown,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const write = async (): Promise<void> => {
    ensureMossRuntimeGitignore(workspaceDir);
    const dir = await mossDir(workspaceDir);
    await appendJsonlFile(path.join(dir, name), record, signal);
  };
  // Event callers already hold the non-reentrant workspace lock. Other task
  // records join it so a failed durability barrier can safely undo its append.
  if (name === EVENTS_FILE) await write();
  else await withTaskEventLock(workspaceDir, write);
}

// --- events -----------------------------------------------------------------

export async function listTaskEvents(workspaceDir: string, taskId?: string): Promise<TaskEvent[]> {
  const parsed = await readJsonl<TaskEvent>(path.join(workspaceDir, '.moss', EVENTS_FILE));
  return taskId ? parsed.filter((event) => event.taskId === taskId) : parsed;
}

/** eventIds already warned about. Later replays in this process only debug. */
const replayWarnedEventIds = new Set<string>();

/**
 * Phase reconstructed by folding events through the machine (audit path).
 * An illegal event is skipped so one bad sequence cannot break /task status
 * or /goal clear for the whole workspace. The first sight of an eventId warns
 * once; every later replay only debugs, so a status refresh does not write
 * stderr under the TUI. New writes still go through appendTaskEvent, which
 * rejects illegal transitions.
 *
 * Tolerant replay can move a task that was mis-ordered while
 * `verification_started` from `accepted` was still legal (the P2 window):
 * those later fail/repair events no longer apply, so the fold stops on the
 * earlier acceptance.
 */
export function replayTaskPhase(events: TaskEvent[]): TaskPhase {
  return foldTaskEvents(events).phase;
}

function foldTaskEvents(events: TaskEvent[]): { phase: TaskPhase; applied: TaskEvent[] } {
  let phase: TaskPhase = 'draft';
  const applied: TaskEvent[] = [];
  for (const event of events) {
    const next = nextTaskPhase(phase, event.type, resumePhaseFromEvent(event), event.data);
    if (next === null) {
      reportSkippedReplayEvent(event, phase);
      continue;
    }
    phase = next;
    applied.push(event);
  }
  return { phase, applied };
}

function reportSkippedReplayEvent(event: TaskEvent, phase: TaskPhase): void {
  const eventId = event.eventId || `${event.taskId}:${event.timestamp}:${event.type}`;
  const data = {
    taskId: event.taskId,
    eventId: event.eventId,
    type: event.type,
    phase,
  };
  if (replayWarnedEventIds.has(eventId)) {
    log.debug('skipping illegal task event during replay', data);
    return;
  }
  replayWarnedEventIds.add(eventId);
  log.warn('skipping illegal task event during replay', data);
}

function resumePhaseFromEvent(event: TaskEvent): TaskPhase | undefined {
  const raw = event.data?.resumePhase;
  return typeof raw === 'string' ? (raw as TaskPhase) : undefined;
}

/**
 * Append a lifecycle event, validating the transition against the machine.
 * The stored event carries the machine-applied next phase, so readers can
 * trust `events.at(-1).phase` without re-folding. Invalid transitions throw
 * EXECUTION_STATE_INVALID — this is the guard that keeps the model honest.
 */
export async function appendTaskEvent(
  workspaceDir: string,
  taskId: string,
  type: TaskEventType,
  data?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TaskEvent> {
  signal?.throwIfAborted();
  return withTaskEventLock(workspaceDir, () =>
    appendTaskEventUnlocked(workspaceDir, taskId, type, data, signal)
  );
}

async function appendTaskEventUnlocked(
  workspaceDir: string,
  taskId: string,
  type: TaskEventType,
  data?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TaskEvent> {
  signal?.throwIfAborted();
  const events = await listTaskEvents(workspaceDir, taskId);
  signal?.throwIfAborted();
  const current = events.length > 0 ? replayTaskPhase(events) : 'draft';
  const next = nextTaskPhase(
    current,
    type,
    typeof data?.resumePhase === 'string' ? (data.resumePhase as TaskPhase) : undefined,
    data
  );
  if (next === null) {
    throw new MossError({
      code: ErrorCode.EXECUTION_STATE_INVALID,
      message: `task ${taskId}: event ${type} is not valid from phase ${current}`,
      hint: 'Lifecycle phases only move through recorded events; check the transition table in contracts/task-runtime.ts.',
      context: { taskId, type, current },
    });
  }
  const event: TaskEvent = {
    eventId: newId('evt'),
    taskId,
    type,
    timestamp: Date.now(),
    phase: next,
    ...(data ? { data } : {}),
  };
  await appendJsonl(workspaceDir, EVENTS_FILE, event, signal);
  if (experienceEnabled()) {
    await recordAcceptedExperience(workspaceDir, event).catch(() => {
      // Optional bookkeeping must not fail the task state machine.
    });
  }
  return event;
}

/**
 * Tool-facing tolerant variant: emits info/lifecycle events only when the
 * task exists and is in a live phase where the event is valid; returns null
 * otherwise (e.g. after acceptance, or for a task the runtime never saw).
 * The engine uses the strict appendTaskEvent; tools use this so a verdict on
 * a settled task is a no-op rather than an error.
 */
export async function tryAppendTaskEvent(
  workspaceDir: string,
  taskId: string,
  type: TaskEventType,
  data?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TaskEvent | null> {
  try {
    return await appendTaskEvent(workspaceDir, taskId, type, data, signal);
  } catch (err) {
    if (err instanceof MossError && err.code === ErrorCode.EXECUTION_STATE_INVALID) {
      return null;
    }
    throw err;
  }
}

/** Latest-updated task whose lifecycle phase is not terminal (or null). */
export async function findLatestLiveTaskSnapshot(
  workspaceDir: string
): Promise<TaskStateSnapshot | null> {
  const snapshots = await listTaskStateSnapshots(workspaceDir);
  const live = snapshots
    .filter((snapshot) => !isTerminalTaskPhase(snapshot.phase))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return live[0] ?? null;
}

/**
 * Emit the lifecycle events an acceptance verdict implies: entering
 * verification from execution/diagnosis/repair, then the verdict. Tolerant on
 * unsettled (draft/understanding/planning — no execution yet) and settled
 * (terminal) tasks — the verdict itself remains the source of truth. Shared
 * by the task tools and the headless verify path.
 */
export async function emitAcceptanceLifecycle(
  workspaceDir: string,
  taskId: string,
  passed: boolean,
  detail: string,
  source?: 'command' | 'contract',
  signal?: AbortSignal
): Promise<void> {
  const events = await listTaskEvents(workspaceDir, taskId);
  if (events.length === 0) return;
  const phase = replayTaskPhase(events);
  if (isTerminalTaskPhase(phase)) return;
  signal?.throwIfAborted();
  if (['ready', 'executing', 'diagnosing', 'repairing'].includes(phase)) {
    await tryAppendTaskEvent(workspaceDir, taskId, 'verification_started', undefined, signal);
  }
  await tryAppendTaskEvent(
    workspaceDir,
    taskId,
    passed ? 'acceptance_pass' : 'acceptance_fail',
    {
      detail: detail.slice(0, 400),
      ...(source ? { acceptanceSource: source } : {}),
    },
    signal
  );
}

// --- failures & repairs -------------------------------------------------------

/**
 * Record a failure (new) or update one (pass failureId of an existing
 * record — latest version wins on read, mirroring contract semantics).
 */
export async function recordFailure(
  workspaceDir: string,
  failure: Omit<FailureRecord, 'failureId' | 'timestamp'> & { failureId?: string }
): Promise<FailureRecord> {
  const record: FailureRecord = {
    ...failure,
    failureId: failure.failureId ?? newId('fail'),
    timestamp: Date.now(),
  };
  await appendJsonl(workspaceDir, FAILURES_FILE, record);
  return record;
}

export async function listFailures(
  workspaceDir: string,
  taskId?: string
): Promise<FailureRecord[]> {
  const parsed = await readJsonl<FailureRecord>(path.join(workspaceDir, '.moss', FAILURES_FILE));
  const byId = new Map<string, FailureRecord>();
  for (const failure of parsed) {
    if (taskId && failure.taskId !== taskId) continue;
    byId.set(failure.failureId, failure); // latest version of a failure wins
  }
  return [...byId.values()];
}

export async function recordRepair(
  workspaceDir: string,
  repair: Omit<RepairRecord, 'repairId' | 'timestamp'>
): Promise<RepairRecord> {
  const record: RepairRecord = { ...repair, repairId: newId('rep'), timestamp: Date.now() };
  await appendJsonl(workspaceDir, REPAIRS_FILE, record);
  return record;
}

export async function listRepairs(workspaceDir: string, taskId?: string): Promise<RepairRecord[]> {
  const parsed = await readJsonl<RepairRecord>(path.join(workspaceDir, '.moss', REPAIRS_FILE));
  return taskId ? parsed.filter((repair) => repair.taskId === taskId) : parsed;
}

// --- task creation ------------------------------------------------------------

/**
 * Create a task in draft: a contract with empty criteria (the agent fills
 * them via task_define during planning) plus a task_created event. This is
 * the only way a task enters the unified runtime.
 */
export async function createDraftTask(
  workspaceDir: string,
  goal: string,
  options: { targetDeviceId?: string; constraints?: string[]; acceptanceCommand?: string } = {}
): Promise<TaskContract> {
  const now = Date.now();
  const contract: TaskContract = {
    taskId: newId('task'),
    goal,
    acceptanceCriteria: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    ...(options.targetDeviceId ? { targetDeviceId: options.targetDeviceId } : {}),
    ...(options.constraints?.length ? { constraints: options.constraints } : {}),
  };
  await appendTaskRecord(workspaceDir, contract);
  await appendTaskEvent(workspaceDir, contract.taskId, 'task_created', {
    goal,
    ...(options.acceptanceCommand ? { acceptanceCommand: options.acceptanceCommand } : {}),
  });
  return contract;
}

// --- snapshots ----------------------------------------------------------------

function planFromEvents(events: TaskEvent[]): TaskPlanStep[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const raw = events[i].data?.steps;
    if (Array.isArray(raw)) return raw as TaskPlanStep[];
  }
  return [];
}

function blockedReasonFromEvents(events: TaskEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'unblocked') return undefined;
    if (event.type === 'blocked_on_user') {
      const reason = event.data?.reason;
      return typeof reason === 'string' ? reason : 'user decision required';
    }
  }
  return undefined;
}

export async function listAcceptanceVerdicts(
  workspaceDir: string,
  taskId?: string
): Promise<AcceptanceVerdict[]> {
  const parsed = await readJsonl<AcceptanceVerdict>(
    path.join(workspaceDir, '.moss', 'acceptance.jsonl')
  );
  return taskId ? parsed.filter((verdict) => verdict.taskId === taskId) : parsed;
}

export async function getTaskStateSnapshot(
  workspaceDir: string,
  taskId: string
): Promise<TaskStateSnapshot | null> {
  return withTaskArtifactReadLock(workspaceDir, async () => {
    const tasks = await listTaskRecords(workspaceDir);
    const contract = tasks.find((task) => task.taskId === taskId);
    if (!contract) return null;

    const reads = [
      listTaskEvents(workspaceDir, taskId),
      listFailures(workspaceDir, taskId),
      listRepairs(workspaceDir, taskId),
      listEvidenceRecords(workspaceDir, 1000),
      listAcceptanceVerdicts(workspaceDir, taskId),
    ] as const;
    const [events, failures, repairs, evidence, verdicts] = await Promise.all(reads).catch(
      async (error) => {
        // Keep ownership until every sibling read has stopped using this snapshot.
        await Promise.allSettled(reads);
        throw error;
      }
    );

    const folded = foldTaskEvents(events);
    const phase = folded.phase;
    const applied = folded.applied;
    const attempt = applied.filter((event) => event.type === 'verification_started').length;
    const taskEvidence = evidence.filter((record) => record.taskId === taskId);
    const aborted = phase === 'failed' && latestTaskFailureDetail(applied) === 'aborted';
    const outcome = aborted ? 'aborted' : deriveTaskOutcome(phase);
    const lastVerdict = latestAcceptanceVerdict(verdicts);

    return {
      taskId,
      goal: contract.goal,
      phase,
      statusView: taskStatusView(phase),
      ...(outcome ? { outcome } : {}),
      ...(contract.targetDeviceId ? { targetDeviceId: contract.targetDeviceId } : {}),
      contractStatus: contract.status,
      plan: planFromEvents(applied),
      acceptanceCriteria: contract.acceptanceCriteria,
      ...(contract.verificationPlan ? { verificationPlan: contract.verificationPlan } : {}),
      attempt,
      failures,
      repairs,
      evidenceCount: taskEvidence.length,
      ...(lastVerdict ? { lastVerdict } : {}),
      ...(phase === 'blocked' ? { blockedReason: blockedReasonFromEvents(applied) } : {}),
      createdAt: contract.createdAt,
      updatedAt: Math.max(contract.updatedAt, ...applied.map((event) => event.timestamp), 0),
    };
  });
}

export async function listTaskStateSnapshots(workspaceDir: string): Promise<TaskStateSnapshot[]> {
  const tasks = await listTaskRecords(workspaceDir);
  const snapshots = await Promise.all(
    tasks.map((task) => getTaskStateSnapshot(workspaceDir, task.taskId))
  );
  return snapshots.filter((snapshot): snapshot is TaskStateSnapshot => snapshot !== null);
}

/**
 * Compact live-task brief prepended to sub-agent prompts (§14: expert agents
 * share the task context instead of working from an isolated prompt). Empty
 * when no live task exists — sub-agents keep their bare task text.
 */
export async function buildTaskContextBrief(workspaceDir: string): Promise<string> {
  const snapshot = await findLatestLiveTaskSnapshot(workspaceDir);
  if (!snapshot) return '';
  const lines = ['[Task context you are part of]', `goal: ${snapshot.goal}`];
  if (snapshot.targetDeviceId) lines.push(`device: ${snapshot.targetDeviceId}`);
  lines.push(`phase: ${snapshot.phase} · verification attempt ${snapshot.attempt}`);
  if (snapshot.plan.length > 0) {
    lines.push(
      `plan: ${snapshot.plan
        .map(
          (step) =>
            `${step.status === 'done' ? 'x' : step.status === 'in_progress' ? '>' : ' '}${step.title}`
        )
        .join(' | ')
        .slice(0, 400)}`
    );
  }
  if (snapshot.acceptanceCriteria.length > 0) {
    lines.push(
      `acceptance: ${snapshot.acceptanceCriteria
        .map((c) => `${c.metric} ${c.expected}`)
        .join('; ')
        .slice(0, 300)}`
    );
  }
  const open = snapshot.failures.filter((failure) => !failure.resolved);
  if (open.length > 0) {
    lines.push(
      `open failures: ${open
        .map((f) => f.symptom.slice(0, 80))
        .join(' ; ')
        .slice(0, 300)}`
    );
  }
  lines.push(`task_id: ${snapshot.taskId} — link any record_evidence to it.`);
  return lines.join('\n');
}

// --- timeline -----------------------------------------------------------------

const TIMELINE_LABELS: Record<TaskEventType, string> = {
  task_created: 'Task created',
  task_understood: 'Goal understood',
  planning_started: 'Planning',
  plan_ready: 'Plan ready',
  execution_started: 'Execution started',
  plan_step_updated: 'Plan updated',
  evidence_recorded: 'Evidence recorded',
  deployment_recorded: 'Deployment recorded',
  verification_started: 'Verification started',
  verification_failed: 'Verification failed',
  acceptance_pass: 'Acceptance passed',
  acceptance_fail: 'Acceptance failed',
  diagnosis_recorded: 'Diagnosis',
  repair_applied: 'Repair applied',
  blocked_on_user: 'Blocked — needs user',
  unblocked: 'Unblocked',
  task_failed: 'Task failed',
  task_abandoned: 'Abandoned',
  task_resumed: 'Resumed',
  note: 'Note',
};

export interface TaskTimelineEntry {
  at: number;
  label: string;
  detail?: string;
  phase: TaskPhase;
}

export function buildTaskTimeline(events: TaskEvent[]): TaskTimelineEntry[] {
  return foldTaskEvents(events).applied.map((event) => {
    const aborted = event.type === 'task_failed' && event.data?.detail === 'aborted';
    const label = aborted ? 'Task aborted' : TIMELINE_LABELS[event.type];
    const detail = aborted
      ? undefined
      : typeof event.data?.detail === 'string'
        ? event.data.detail
        : typeof event.data?.reason === 'string'
          ? event.data.reason
          : typeof event.data?.goal === 'string'
            ? event.data.goal
            : undefined;
    return { at: event.timestamp, label, ...(detail ? { detail } : {}), phase: event.phase };
  });
}

export function formatTaskTimeline(entries: TaskTimelineEntry[]): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `${time} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`;
    })
    .join('\n');
}

/** Terminal-phase helper for interfaces deciding whether a task is done. */
export function isTaskSettled(snapshot: TaskStateSnapshot): boolean {
  return isTerminalTaskPhase(snapshot.phase);
}

/**
 * One queue per real directory. A symlink or (on Windows) a different case
 * must not take a second queue and then delete the holder's lock as stale.
 */
async function taskEventQueueKey(workspaceDir: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(workspaceDir);
  } catch {
    resolved = path.resolve(workspaceDir);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function enqueueTaskEventWrite<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const key = await taskEventQueueKey(workspaceDir);
  const previous = taskEventWriteChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  taskEventWriteChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/** One reliable workspace mutex; nested reads may reuse their caller's lock. */
export async function withTaskEventLock<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const key = await taskEventQueueKey(workspaceDir);
  if (ownsTaskLock(key)) throw new Error('task artifact write lock is not re-entrant');
  return enqueueTaskEventWrite(workspaceDir, async () => {
    const dir = await mossDir(workspaceDir);
    const lockPath = path.join(dir, EVENTS_FILE);
    let lock;
    try {
      lock = await acquireTaskArtifactWriteLock(lockPath, EVENT_LOCK_WAIT_MS);
    } catch (error) {
      const cause = (error as Error).cause;
      if (cause instanceof Error && cause.message === 'lock acquisition timed out') {
        throw new MossError({
          code: ErrorCode.EXECUTION_LEASE_HELD,
          message: 'timed out waiting for the task event lock (task-events.jsonl.lock)',
          context: { lockPath },
        });
      }
      if (cause && ['EPERM', 'EACCES'].includes((cause as NodeJS.ErrnoException).code ?? ''))
        throw cause;
      throw error;
    }
    const scope: TaskLockScope = { key, active: true, parent: taskLockScope.getStore() };
    try {
      return await taskLockScope.run(scope, fn);
    } finally {
      scope.active = false;
      await lock.release();
    }
  });
}

/** Read under the writer's mutex, preventing replay of a rolled-back cached tail. */
export async function withTaskArtifactReadLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = await taskEventQueueKey(workspaceDir);
  if (ownsTaskLock(key)) return fn();
  return withTaskEventLock(workspaceDir, fn);
}
