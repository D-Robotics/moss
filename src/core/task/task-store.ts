/**
 * Task store (Task OS M2) — the single write path for task lifecycle state.
 * Contracts/evidence/verdicts keep flowing through the shared artifact IO
 * (core/task-runtime/artifacts.ts); lifecycle state is event-sourced into
 * .moss/task-events.jsonl and validated by the contract state machine, so a
 * phase can only move because a real event happened — never because the
 * model asserted it. Failures and repairs are first-class JSONL records.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { MossError, ErrorCode } from '../../errors.js';
import type { AcceptanceVerdict, TaskContract } from '../../contracts/task.js';
import {
  nextTaskPhase,
  taskStatusView,
  deriveTaskOutcome,
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
import {
  appendTaskRecord,
  listEvidenceRecords,
  listTaskRecords,
} from '../task-runtime/artifacts.js';

const EVENTS_FILE = 'task-events.jsonl';
const FAILURES_FILE = 'task-failures.jsonl';
const REPAIRS_FILE = 'task-repairs.jsonl';

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function mossDir(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function appendJsonl(workspaceDir: string, name: string, record: unknown): Promise<void> {
  const dir = await mossDir(workspaceDir);
  await fs.appendFile(path.join(dir, name), `${JSON.stringify(record)}\n`, 'utf8');
}

// --- events -----------------------------------------------------------------

export async function listTaskEvents(workspaceDir: string, taskId?: string): Promise<TaskEvent[]> {
  const parsed = await readJsonl<TaskEvent>(path.join(workspaceDir, '.moss', EVENTS_FILE));
  return taskId ? parsed.filter((event) => event.taskId === taskId) : parsed;
}

/** Phase reconstructed by folding events through the machine (audit path). */
export function replayTaskPhase(events: TaskEvent[]): TaskPhase {
  let phase: TaskPhase = 'draft';
  for (const event of events) {
    const next = nextTaskPhase(phase, event.type, resumePhaseFromEvent(event));
    if (next === null) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `task event ${event.type} is invalid for phase ${phase} (event ${event.eventId})`,
        context: { taskId: event.taskId, eventId: event.eventId, type: event.type, phase },
      });
    }
    phase = next;
  }
  return phase;
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
  data?: Record<string, unknown>
): Promise<TaskEvent> {
  const events = await listTaskEvents(workspaceDir, taskId);
  const current = events.length > 0 ? replayTaskPhase(events) : 'draft';
  const next = nextTaskPhase(
    current,
    type,
    typeof data?.resumePhase === 'string' ? (data.resumePhase as TaskPhase) : undefined
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
  await appendJsonl(workspaceDir, EVENTS_FILE, event);
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
  data?: Record<string, unknown>
): Promise<TaskEvent | null> {
  try {
    return await appendTaskEvent(workspaceDir, taskId, type, data);
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
 * by the task tools, the goal-loop mirror and the headless verify path.
 */
export async function emitAcceptanceLifecycle(
  workspaceDir: string,
  taskId: string,
  passed: boolean,
  detail: string
): Promise<void> {
  const events = await listTaskEvents(workspaceDir, taskId);
  if (events.length === 0) return;
  const phase = replayTaskPhase(events);
  if (isTerminalTaskPhase(phase)) return;
  if (['ready', 'executing', 'diagnosing', 'repairing'].includes(phase)) {
    await tryAppendTaskEvent(workspaceDir, taskId, 'verification_started');
  }
  await tryAppendTaskEvent(workspaceDir, taskId, passed ? 'acceptance_pass' : 'acceptance_fail', {
    detail: detail.slice(0, 400),
  });
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
  options: { targetDeviceId?: string; constraints?: string[] } = {}
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
  await appendTaskEvent(workspaceDir, contract.taskId, 'task_created', { goal });
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
  const tasks = await listTaskRecords(workspaceDir);
  const contract = tasks.find((task) => task.taskId === taskId);
  if (!contract) return null;

  const [events, failures, repairs, evidence, verdicts] = await Promise.all([
    listTaskEvents(workspaceDir, taskId),
    listFailures(workspaceDir, taskId),
    listRepairs(workspaceDir, taskId),
    listEvidenceRecords(workspaceDir, 1000),
    listAcceptanceVerdicts(workspaceDir, taskId),
  ]);

  const phase = events.length > 0 ? replayTaskPhase(events) : 'draft';
  const attempt = events.filter((event) => event.type === 'verification_started').length;
  const taskEvidence = evidence.filter((record) => record.taskId === taskId);

  return {
    taskId,
    goal: contract.goal,
    phase,
    statusView: taskStatusView(phase),
    ...(deriveTaskOutcome(phase) ? { outcome: deriveTaskOutcome(phase) } : {}),
    ...(contract.targetDeviceId ? { targetDeviceId: contract.targetDeviceId } : {}),
    contractStatus: contract.status,
    plan: planFromEvents(events),
    acceptanceCriteria: contract.acceptanceCriteria,
    ...(contract.verificationPlan ? { verificationPlan: contract.verificationPlan } : {}),
    attempt,
    failures,
    repairs,
    evidenceCount: taskEvidence.length,
    ...(verdicts.length > 0 ? { lastVerdict: verdicts[verdicts.length - 1] } : {}),
    ...(phase === 'blocked' ? { blockedReason: blockedReasonFromEvents(events) } : {}),
    createdAt: contract.createdAt,
    updatedAt: Math.max(contract.updatedAt, ...events.map((event) => event.timestamp), 0),
  };
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
  return events.map((event) => {
    const label = TIMELINE_LABELS[event.type];
    const detail =
      typeof event.data?.detail === 'string'
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
