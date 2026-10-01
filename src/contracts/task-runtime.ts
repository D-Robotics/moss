/**
 * Task runtime contract (Task OS, 2026-09-30) — the unified model that merges
 * the goal loop, task contract, evidence, acceptance and repair into ONE
 * state machine. Phases move only through recorded events: an agent saying
 * "Task completed" is not an event and can never move the state.
 *
 * Pure and dependency-free apart from task contract types.
 */

import type { AcceptanceCriterion, AcceptanceVerdict, TaskContractStatus } from './task.js';

/**
 * Lifecycle phases. Terminal: accepted / failed / abandoned.
 * Repair cycle: verifying --fail--> diagnosing -> repairing -> reverifying.
 */
export type TaskPhase =
  | 'draft'
  | 'understanding'
  | 'planning'
  | 'ready'
  | 'executing'
  | 'verifying'
  | 'diagnosing'
  | 'repairing'
  | 'reverifying'
  | 'accepted'
  | 'failed'
  | 'blocked'
  | 'abandoned';

export const TASK_PHASES: readonly TaskPhase[] = [
  'draft',
  'understanding',
  'planning',
  'ready',
  'executing',
  'verifying',
  'diagnosing',
  'repairing',
  'reverifying',
  'accepted',
  'failed',
  'blocked',
  'abandoned',
];

/** User-facing coarse status (TUI top line): no internal jargon. */
export type TaskStatusView = 'idle' | 'planning' | 'executing' | 'blocked' | 'completed';

/** User-facing result once a task reaches a verdict-ish phase. */
export type TaskOutcome = 'pass' | 'fail' | 'needs-user';

export type TaskEventType =
  | 'task_created'
  | 'task_understood'
  | 'planning_started'
  | 'plan_ready'
  | 'execution_started'
  | 'plan_step_updated'
  | 'evidence_recorded'
  | 'deployment_recorded'
  | 'verification_started'
  | 'verification_failed'
  | 'acceptance_pass'
  | 'acceptance_fail'
  | 'diagnosis_recorded'
  | 'repair_applied'
  | 'blocked_on_user'
  | 'unblocked'
  | 'task_failed'
  | 'task_abandoned'
  | 'task_resumed'
  | 'note';

/** A plan step as shown to the user (not the internal todo list). */
export interface TaskPlanStep {
  stepId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

/** Failure is a first-class record, not a lost stderr line. */
export interface FailureRecord {
  failureId: string;
  taskId: string;
  /** Phase where the failure surfaced, e.g. 'verifying'. */
  stage: TaskPhase;
  /** What was observed going wrong, e.g. 'camera_fps expected >=30, observed 17.2'. */
  symptom: string;
  evidenceIds?: string[];
  /** Agent (or human) diagnosis narrative. */
  diagnosis?: string;
  /** Root cause once identified. */
  rootCause?: string;
  /** 1-based verification attempt this failure belongs to. */
  attempt: number;
  resolved: boolean;
  timestamp: number;
}

export interface RepairRecord {
  repairId: string;
  taskId: string;
  failureId?: string;
  /** What was changed to fix the failure. */
  action: string;
  changedFiles?: string[];
  redeployed?: boolean;
  timestamp: number;
}

/** Append-only timeline event; `phase` is the phase AFTER applying the event. */
export interface TaskEvent {
  eventId: string;
  taskId: string;
  type: TaskEventType;
  timestamp: number;
  phase: TaskPhase;
  data?: Record<string, unknown>;
}

/**
 * The single object every interface (TUI / REPL / headless / SDK) renders.
 * Assembled by the task store from contracts + events + failures + repairs.
 */
export interface TaskStateSnapshot {
  taskId: string;
  goal: string;
  phase: TaskPhase;
  statusView: TaskStatusView;
  outcome?: TaskOutcome;
  targetDeviceId?: string;
  /** Legacy contract status kept in sync for existing consumers. */
  contractStatus: TaskContractStatus;
  plan: TaskPlanStep[];
  acceptanceCriteria: AcceptanceCriterion[];
  verificationPlan?: string[];
  /** 1-based verification attempt currently in flight. */
  attempt: number;
  failures: FailureRecord[];
  repairs: RepairRecord[];
  evidenceCount: number;
  lastVerdict?: AcceptanceVerdict;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export function isTerminalTaskPhase(phase: TaskPhase): boolean {
  return phase === 'accepted' || phase === 'failed' || phase === 'abandoned';
}

export function taskStatusView(phase: TaskPhase): TaskStatusView {
  switch (phase) {
    case 'draft':
      return 'idle';
    case 'understanding':
    case 'planning':
    case 'ready':
      return 'planning';
    case 'executing':
    case 'verifying':
    case 'diagnosing':
    case 'repairing':
    case 'reverifying':
      return 'executing';
    case 'blocked':
      return 'blocked';
    case 'accepted':
    case 'failed':
    case 'abandoned':
      return 'completed';
  }
}

export function deriveTaskOutcome(phase: TaskPhase): TaskOutcome | undefined {
  if (phase === 'accepted') return 'pass';
  if (phase === 'failed' || phase === 'abandoned') return 'fail';
  if (phase === 'blocked') return 'needs-user';
  return undefined;
}

type TransitionTable = Partial<Record<TaskEventType, Partial<Record<TaskPhase, TaskPhase>>>>;

/**
 * Event -> phase transition table. Verification from executing enters
 * 'verifying'; from the repair cycle it enters 'reverifying'. Acceptance can
 * only be granted from a verification phase — never from 'executing', so an
 * agent cannot talk its way to accepted.
 */
const TRANSITIONS: TransitionTable = {
  task_understood: { draft: 'understanding' },
  planning_started: { draft: 'planning', understanding: 'planning' },
  plan_ready: { draft: 'ready', understanding: 'ready', planning: 'ready' },
  execution_started: {
    draft: 'executing',
    understanding: 'executing',
    planning: 'executing',
    ready: 'executing',
    blocked: 'executing',
  },
  verification_started: {
    executing: 'verifying',
    ready: 'verifying',
    diagnosing: 'reverifying',
    repairing: 'reverifying',
  },
  verification_failed: { verifying: 'diagnosing', reverifying: 'diagnosing' },
  acceptance_fail: { verifying: 'diagnosing', reverifying: 'diagnosing' },
  acceptance_pass: { verifying: 'accepted', reverifying: 'accepted' },
  diagnosis_recorded: { diagnosing: 'diagnosing' },
  repair_applied: { diagnosing: 'repairing', repairing: 'repairing', executing: 'repairing' },
  blocked_on_user: {
    draft: 'blocked',
    understanding: 'blocked',
    planning: 'blocked',
    ready: 'blocked',
    executing: 'blocked',
    verifying: 'blocked',
    diagnosing: 'blocked',
    repairing: 'blocked',
    reverifying: 'blocked',
  },
  unblocked: { blocked: 'executing' },
  task_failed: {
    understanding: 'failed',
    planning: 'failed',
    ready: 'failed',
    executing: 'failed',
    verifying: 'failed',
    diagnosing: 'failed',
    repairing: 'failed',
    reverifying: 'failed',
    blocked: 'failed',
  },
  task_abandoned: {
    draft: 'abandoned',
    understanding: 'abandoned',
    planning: 'abandoned',
    ready: 'abandoned',
    executing: 'abandoned',
    verifying: 'abandoned',
    diagnosing: 'abandoned',
    repairing: 'abandoned',
    reverifying: 'abandoned',
    blocked: 'abandoned',
  },
  task_resumed: { failed: 'executing', abandoned: 'executing', blocked: 'executing' },
};

// Informational events: recorded on the timeline without moving the phase.
const INFO_EVENTS: ReadonlySet<TaskEventType> = new Set<TaskEventType>([
  'task_created',
  'plan_step_updated',
  'evidence_recorded',
  'deployment_recorded',
  'note',
]);

/**
 * Pure transition function. Returns the next phase, or null when the event is
 * invalid for the current phase (e.g. acceptance_pass while executing, any
 * event after a terminal phase). `resumePhase` lets `unblocked` return to a
 * phase other than the default 'executing'.
 */
export function nextTaskPhase(
  phase: TaskPhase,
  event: TaskEventType,
  resumePhase?: TaskPhase
): TaskPhase | null {
  if (isTerminalTaskPhase(phase)) {
    // failed/abandoned tasks can be explicitly resumed (recover); accepted is
    // final — replay means creating a new task, not mutating the record.
    if (event === 'task_resumed' && phase !== 'accepted') {
      return 'executing';
    }
    return null;
  }
  if (INFO_EVENTS.has(event)) return phase;
  if (event === 'unblocked' && phase === 'blocked') {
    if (resumePhase && (!TASK_PHASES.includes(resumePhase) || isTerminalTaskPhase(resumePhase))) {
      return null;
    }
    return resumePhase ?? 'executing';
  }
  const row = TRANSITIONS[event];
  const next = row?.[phase];
  return next ?? null;
}

export function formatTaskPhase(phase: TaskPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** Format a failure + its repair the way the user should read it. */
export function formatFailureRecord(failure: FailureRecord, repairs: RepairRecord[]): string {
  const lines = [`FAIL #${failure.attempt} [${failure.stage}] ${failure.symptom}`];
  if (failure.diagnosis) lines.push(`Diagnosis: ${failure.diagnosis}`);
  if (failure.rootCause) lines.push(`Root cause: ${failure.rootCause}`);
  const linked = repairs.filter((r) => r.failureId === failure.failureId);
  for (const repair of linked) {
    lines.push(`Repair: ${repair.action}`);
    if (repair.changedFiles?.length) lines.push(`Changed: ${repair.changedFiles.join(', ')}`);
  }
  lines.push(failure.resolved ? 'Status: resolved' : 'Status: unresolved');
  return lines.join('\n');
}
