/**
 * Task engine (Task OS M3) — drives one task from natural-language goal to a
 * verified result. The engine owns every phase-moving lifecycle event; the
 * agent (via tools) owns evidence, failures and repairs as records. Goal
 * loop and robotics acceptance stop being two systems here: both are just a
 * verdict provider consulted in the VERIFYING phase.
 */
import type { TaskStateSnapshot } from '../../contracts/task-runtime.js';
import {
  appendTaskEvent,
  buildTaskTimeline,
  createDraftTask,
  formatTaskTimeline,
  getTaskStateSnapshot,
  listTaskEvents,
  tryAppendTaskEvent,
} from './task-store.js';
import type { TaskVerdict, VerdictProvider } from './verdict.js';
import { createTaskVerdictProvider } from './verdict.js';

export interface TaskEngineDeps {
  workspaceDir: string;
  /** One agent turn: prompt in, final assistant text out. */
  runTurn: (prompt: string, phase: string) => Promise<string>;
  /** Defaults to contract acceptance; a command provider overrides it. */
  verdictProvider?: VerdictProvider;
  /** Repair cycles before the task is declared failed (default 5). */
  maxRepairAttempts?: number;
  /** Safety bound on total agent turns (default 24). */
  maxTurns?: number;
  signal?: AbortSignal;
  /** Live progress for interfaces (TUI / REPL / headless). */
  onProgress?: (progress: TaskEngineProgress) => void;
}

export interface TaskEngineProgress {
  taskId: string;
  phase: string;
  turn: number;
  detail: string;
}

export interface TaskRunResult {
  snapshot: TaskStateSnapshot;
  /** User-facing word for how the run ended. */
  outcome: 'pass' | 'fail' | 'blocked';
  verdictDetail?: string;
  timeline: string;
  turns: number;
}

/**
 * Long tasks need more than a demo loop. Two repairs and eight turns ended
 * real failure-repair work while the diagnosis was still moving. Callers can
 * still pass a tighter budget.
 */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 5;
export const DEFAULT_MAX_TURNS = 24;

function planningPrompt(
  goal: string,
  taskId: string,
  acceptanceCommand?: string,
  capabilityLayer?: string
): string {
  return [
    'You are planning a task for the moss task runtime. Understand the goal, then define the contract and plan.',
    '',
    `Goal: ${goal}`,
    acceptanceCommand
      ? `Acceptance authority: the command "${acceptanceCommand}" must exit 0. Define acceptance criteria that mirror what it checks.`
      : 'Acceptance authority: criteria × recorded evidence. Define machine-checkable acceptance criteria (metric + expectation, e.g. camera_fps >=30).',
    ...(capabilityLayer ? ['', capabilityLayer] : []),
    '',
    'Do ALL of the following, then stop (no implementation yet):',
    `1. task_define with task_id="${taskId}" — goal, acceptance_criteria, target_device if a device is involved, verification_plan.`,
    `2. task_plan_update with task_id="${taskId}" — 3-8 concrete steps (inspect → change → build/deploy → verify → accept).`,
    'Do not record evidence yet. Do not claim completion.',
  ].join('\n');
}

function executionPrompt(goal: string, taskId: string, round: number): string {
  return [
    `Execute the task. Goal: ${goal}`,
    `task_id: ${taskId} — pass it to record_evidence / task tools.`,
    round === 1
      ? 'Work through the plan step by step. Record evidence (record_evidence) for every acceptance metric you can measure — real probes only, no asserted values.'
      : 'Continue from where you left off. Fix what failed, re-measure, and record fresh evidence (latest evidence per metric wins).',
    'When every metric has passing evidence, run task_acceptance and report its verdict verbatim.',
  ].join('\n');
}

/** What a repair turn needs to know about repairs/failures already on record. */
interface RepairHistory {
  /** Repair actions already applied (oldest first), capped to keep prompts small. */
  repairs: string[];
  /** Symptoms of failures still unresolved, capped likewise. */
  openFailures: string[];
}

const REPAIR_HISTORY_MAX_ENTRIES = 3;
const REPAIR_HISTORY_MAX_CHARS = 200;

function repairHistoryFrom(snapshot: TaskStateSnapshot | null): RepairHistory {
  if (!snapshot) return { repairs: [], openFailures: [] };
  const clip = (text: string): string =>
    text.length > REPAIR_HISTORY_MAX_CHARS ? `${text.slice(0, REPAIR_HISTORY_MAX_CHARS)}…` : text;
  return {
    repairs: snapshot.repairs
      .slice(-REPAIR_HISTORY_MAX_ENTRIES)
      .map((repair) => clip(repair.action)),
    openFailures: snapshot.failures
      .filter((failure) => !failure.resolved)
      .slice(-REPAIR_HISTORY_MAX_ENTRIES)
      .map((failure) => clip(failure.symptom)),
  };
}

function repairPrompt(
  goal: string,
  verdictDetail: string,
  attempt: number,
  history: RepairHistory = { repairs: [], openFailures: [] }
): string {
  const lines = [
    `Verification attempt ${attempt} FAILED. Diagnose and repair, then re-measure.`,
    '',
    'Verdict:',
    verdictDetail,
    '',
    `Goal: ${goal}`,
  ];
  // Reverify failed after at least one applied repair: the fixes below did
  // not clear the verdict, so repeating them burns a repair cycle for
  // nothing. This section is what turns a re-fail into a hypothesis change
  // instead of the same fix re-applied.
  if (history.repairs.length > 0) {
    lines.push('', 'Repairs already applied (verification STILL fails afterwards):');
    for (const repair of history.repairs) lines.push(`- ${repair}`);
    lines.push(
      'These did not clear the verdict. Do NOT repeat them. Form a different root-cause hypothesis, confirm it against a probe of the failing system, then apply a different minimal fix.'
    );
  }
  if (history.openFailures.length > 0) {
    lines.push('', 'Failures still unresolved on record:');
    for (const symptom of history.openFailures) lines.push(`- ${symptom}`);
  }
  lines.push(
    '',
    'Steps:',
    '1. Identify the root cause from the verdict and any logs/probes you need — state it as a hypothesis you can check before editing.',
    '2. record_failure with the symptom and your diagnosis (include task_id).',
    '3. Apply the minimal fix; record_repair with what you changed (include task_id).',
    '4. Re-measure and record fresh evidence for the failing metrics (record_evidence with task_id).',
    'Do not work around or weaken the acceptance criteria. Do not claim success without recorded evidence.'
  );
  return lines.join('\n');
}

interface RunLoopState {
  taskId: string;
  turns: number;
  repairsUsed: number;
  lastVerdict?: TaskVerdict;
}

async function verifyRepairLoop(
  deps: TaskEngineDeps,
  state: RunLoopState,
  provider: VerdictProvider,
  maxRepairAttempts: number
): Promise<'accepted' | 'failed' | 'blocked' | 'budget'> {
  const { workspaceDir } = deps;
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;

  while (true) {
    if (deps.signal?.aborted) {
      await appendTaskEvent(workspaceDir, state.taskId, 'task_failed', { detail: 'aborted' });
      return 'failed';
    }
    const current = await getTaskStateSnapshot(workspaceDir, state.taskId);
    if (!current) return 'failed';
    if (current.phase === 'accepted') return 'accepted';
    if (current.phase === 'failed' || current.phase === 'abandoned') return 'failed';
    if (current.phase === 'blocked') return 'blocked';

    state.turns += 1;
    if (state.turns > maxTurns) {
      await appendTaskEvent(workspaceDir, state.taskId, 'task_failed', {
        detail: `turn budget exhausted (${maxTurns} turns)`,
      });
      return 'budget';
    }
    deps.onProgress?.({
      taskId: state.taskId,
      phase: 'executing',
      turn: state.turns,
      detail: 'agent execution turn',
    });
    await deps.runTurn(
      executionPrompt(current?.goal ?? '', state.taskId, state.repairsUsed + 1),
      'executing'
    );

    // Tolerant: the agent may already have entered verification via the
    // task_acceptance tool during its turn.
    await tryAppendTaskEvent(workspaceDir, state.taskId, 'verification_started');
    deps.onProgress?.({
      taskId: state.taskId,
      phase: 'verifying',
      turn: state.turns,
      detail: 'evaluating acceptance',
    });
    const verdict = await provider.evaluate(state.taskId, deps.signal);
    state.lastVerdict = verdict;

    if (verdict.passed) {
      await tryAppendTaskEvent(workspaceDir, state.taskId, 'acceptance_pass', {
        detail:
          verdict.source === 'command'
            ? 'acceptance command exited 0'
            : 'criteria met with evidence',
      });
      deps.onProgress?.({
        taskId: state.taskId,
        phase: 'accepted',
        turn: state.turns,
        detail: 'acceptance passed',
      });
      return 'accepted';
    }

    await tryAppendTaskEvent(workspaceDir, state.taskId, 'acceptance_fail', {
      detail: verdict.detail.slice(0, 400),
    });
    deps.onProgress?.({
      taskId: state.taskId,
      phase: 'diagnosing',
      turn: state.turns,
      detail: 'verification failed — diagnosing',
    });

    if (state.repairsUsed >= maxRepairAttempts) {
      await appendTaskEvent(workspaceDir, state.taskId, 'task_failed', {
        detail: `verification failed after ${state.repairsUsed + 1} attempts (repair budget exhausted)`,
      });
      return 'failed';
    }
    state.repairsUsed += 1;
    state.turns += 1;
    if (state.turns > maxTurns) {
      await appendTaskEvent(workspaceDir, state.taskId, 'task_failed', {
        detail: `turn budget exhausted (${maxTurns} turns)`,
      });
      return 'budget';
    }
    deps.onProgress?.({
      taskId: state.taskId,
      phase: 'repairing',
      turn: state.turns,
      detail: 'diagnosis + repair turn',
    });
    // Fresh snapshot for the repair turn: repairs/failures the agent recorded
    // during the execution turn above must be visible as history.
    const historySnapshot = await getTaskStateSnapshot(workspaceDir, state.taskId);
    await deps.runTurn(
      repairPrompt(
        current?.goal ?? '',
        verdict.detail,
        state.repairsUsed,
        repairHistoryFrom(historySnapshot)
      ),
      'repairing'
    );
    await appendTaskEvent(workspaceDir, state.taskId, 'repair_applied', {
      detail: `repair attempt ${state.repairsUsed}`,
    });
  }
}

async function buildRunResult(
  workspaceDir: string,
  taskId: string,
  state: RunLoopState
): Promise<TaskRunResult> {
  const snapshot = await getTaskStateSnapshot(workspaceDir, taskId);
  if (!snapshot) throw new Error(`task ${taskId} disappeared from the store`);
  const events = await listTaskEvents(workspaceDir, taskId);
  const outcome: TaskRunResult['outcome'] =
    snapshot.phase === 'accepted' ? 'pass' : snapshot.phase === 'blocked' ? 'blocked' : 'fail';
  return {
    snapshot,
    outcome,
    ...(state.lastVerdict ? { verdictDetail: state.lastVerdict.detail } : {}),
    timeline: formatTaskTimeline(buildTaskTimeline(events)),
    turns: state.turns,
  };
}

/**
 * Run a task end to end. The engine never trusts the agent's prose: PASS can
 * only come from the verdict provider, and every phase move is a validated
 * lifecycle event. Returns the final snapshot, outcome and timeline.
 */
export async function runTask(
  deps: TaskEngineDeps,
  goal: string,
  options: {
    acceptanceCommand?: string;
    targetDeviceId?: string;
    constraints?: string[];
    /** Capability-discovery layer injected into the planning turn (M7). */
    capabilityLayer?: string;
  } = {}
): Promise<TaskRunResult> {
  const provider =
    deps.verdictProvider ??
    createTaskVerdictProvider({
      workspaceDir: deps.workspaceDir,
      ...(options.acceptanceCommand ? { command: options.acceptanceCommand } : {}),
    });
  const maxRepairAttempts = deps.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;

  const contract = await createDraftTask(deps.workspaceDir, goal, {
    ...(options.targetDeviceId ? { targetDeviceId: options.targetDeviceId } : {}),
    ...(options.constraints?.length ? { constraints: options.constraints } : {}),
  });
  const taskId = contract.taskId;
  const state: RunLoopState = { taskId, turns: 0, repairsUsed: 0 };

  await appendTaskEvent(deps.workspaceDir, taskId, 'task_understood');
  await appendTaskEvent(deps.workspaceDir, taskId, 'planning_started');
  deps.onProgress?.({
    taskId,
    phase: 'planning',
    turn: 0,
    detail: 'understanding goal, defining contract + plan',
  });
  state.turns += 1;
  try {
    await deps.runTurn(
      planningPrompt(goal, taskId, options.acceptanceCommand, options.capabilityLayer),
      'planning'
    );
    await appendTaskEvent(deps.workspaceDir, taskId, 'plan_ready');
    await appendTaskEvent(deps.workspaceDir, taskId, 'execution_started');

    await verifyRepairLoop(deps, state, provider, maxRepairAttempts);
  } catch (err) {
    // A crashed run must stay resumable: mark the task failed (valid from any
    // live phase) instead of leaving it stuck in planning/executing where
    // `resumeTask` refuses to re-enter.
    await tryAppendTaskEvent(deps.workspaceDir, taskId, 'task_failed', {
      detail: `run crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    });
    throw err;
  }
  return buildRunResult(deps.workspaceDir, taskId, state);
}

/**
 * Resume a failed/abandoned/blocked task: re-enter executing and run the same
 * verify→repair cycle from current state (no new planning turns).
 */
export async function resumeTask(deps: TaskEngineDeps, taskId: string): Promise<TaskRunResult> {
  const snapshot = await getTaskStateSnapshot(deps.workspaceDir, taskId);
  if (!snapshot) throw new Error(`task ${taskId} not found`);
  if (snapshot.phase === 'accepted') throw new Error(`task ${taskId} is already accepted`);
  if (!['failed', 'abandoned', 'blocked'].includes(snapshot.phase)) {
    throw new Error(`task ${taskId} is ${snapshot.phase}; nothing to resume`);
  }
  await appendTaskEvent(deps.workspaceDir, taskId, 'task_resumed', { detail: 'resumed by user' });
  const provider =
    deps.verdictProvider ?? createTaskVerdictProvider({ workspaceDir: deps.workspaceDir });
  const state: RunLoopState = { taskId, turns: 0, repairsUsed: 0 };
  try {
    await verifyRepairLoop(
      deps,
      state,
      provider,
      deps.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS
    );
  } catch (err) {
    await tryAppendTaskEvent(deps.workspaceDir, taskId, 'task_failed', {
      detail: `run crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    });
    throw err;
  }
  return buildRunResult(deps.workspaceDir, taskId, state);
}

/**
 * User-facing final message assembled from the REAL result (snapshot +
 * verdict + timeline tail) — never from agent prose.
 *
 * Locale (v0.25): the fixed labels (task/goal/phase/attempts/verdict/timeline)
 * follow the caller's locale and match `formatTaskStatus`'s wording. The
 * outcome token (PASS/FAIL/BLOCKED), task id, counts, and the verdict/timeline
 * bodies stay verbatim. Core cannot read the CLI locale (layering), so the
 * caller passes it in — undefined keeps the English default for SDK callers.
 */
export function summarizeTaskRun(result: TaskRunResult, locale?: string): string {
  const zh = typeof locale === 'string' && /^zh/i.test(locale);
  const { snapshot, outcome, verdictDetail, timeline, turns } = result;
  const lines = zh
    ? [
        `任务 ${snapshot.taskId} — ${outcome.toUpperCase()}`,
        `目标: ${snapshot.goal}`,
        `阶段: ${snapshot.phase} · 尝试: ${snapshot.attempt} · 修复: ${snapshot.repairs.length} · 失败: ${snapshot.failures.length} · 轮次: ${turns}`,
      ]
    : [
        `Task ${snapshot.taskId} — ${outcome.toUpperCase()}`,
        `goal: ${snapshot.goal}`,
        `phase: ${snapshot.phase} · attempts: ${snapshot.attempt} · repairs: ${snapshot.repairs.length} · failures: ${snapshot.failures.length} · turns: ${turns}`,
      ];
  if (verdictDetail) lines.push('', zh ? '最终裁决:' : 'Final verdict:', verdictDetail);
  const tail = timeline.split('\n').slice(-6).join('\n');
  if (tail) lines.push('', zh ? '时间线（末尾）:' : 'Timeline (tail):', tail);
  return lines.join('\n');
}
