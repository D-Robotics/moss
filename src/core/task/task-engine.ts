/**
 * Task engine (Task OS M3) — drives one task from natural-language goal to a
 * verified result. The engine owns every phase-moving lifecycle event; the
 * agent (via tools) owns evidence, failures and repairs as records. Goal
 * loop and robotics acceptance stop being two systems here: both are just a
 * verdict provider consulted in the VERIFYING phase.
 */
import {
  isResumableTaskPhase,
  isTerminalTaskPhase,
  latestTaskFailureDetail,
  type TaskStateSnapshot,
} from '../../contracts/task-runtime.js';
import { ErrorCode, MossError } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import {
  appendTaskEvent,
  buildTaskTimeline,
  createDraftTask,
  emitAcceptanceLifecycle,
  formatTaskTimeline,
  getTaskStateSnapshot,
  listTaskEvents,
  tryAppendTaskEvent,
} from './task-store.js';
import { injectExperienceIntoPrompt } from '../experience/experience-library.js';
import type { TaskVerdict, VerdictProvider } from './verdict.js';
import type { AgentTurnResult } from './agent-turn.js';
import { acceptanceAlreadySatisfied, createTaskVerdictProvider } from './verdict.js';

const log = getRootLogger().child('task-engine');

export interface TaskEngineDeps {
  workspaceDir: string;
  /**
   * One agent turn. A string is the assistant text; `runTurn.stopReason` may
   * carry the agent stop reason (the string-returning runner does this).
   * An `AgentTurnResult` object may carry `stopReason` instead. A reason
   * that starts with `budget_` ends the run unless the task is already settled.
   */
  runTurn: (prompt: string, phase: string) => Promise<string | AgentTurnResult>;
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
  /** User-facing word for how the run ended. `aborted` is Esc — resumable, not a crash. */
  outcome: 'pass' | 'fail' | 'blocked' | 'aborted';
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
  const authority = acceptanceCommand
    ? `Acceptance authority: the command "${acceptanceCommand}" must exit 0. Define acceptance criteria that mirror what it checks, then make that command pass.`
    : 'Acceptance authority: criteria × recorded evidence. Define machine-checkable acceptance criteria (metric + expectation, e.g. camera_fps >=30).';
  return [
    '[task-phase:planning]',
    'You are working one moss goal. Complete it in order: plan, then implement, then verify.',
    'Do not stop after the plan. Do not ask the user whether to continue — this goal already includes implementation and verification.',
    'Do not call ask_user_question to ask permission to proceed.',
    '',
    `Goal: ${goal}`,
    authority,
    ...(capabilityLayer ? ['', capabilityLayer] : []),
    '',
    'Keep the change minimal and scoped to the request: do not add features, files, or refactors that were not asked for.',
    'Plan as a short list of at most 3 steps, not a design document.',
    '',
    'Do all of the following in this turn:',
    `1. task_define with task_id="${taskId}" — goal and the few acceptance criteria this change needs.`,
    `2. task_plan_update with task_id="${taskId}" — at most 3 steps (change → verify → accept).`,
    '3. Implement only that change now.',
    '4. Run the acceptance command, or run_tests / verify_fix once. That records tests_pass, build_ok, or typecheck_ok when a criterion uses that exact name. Any other metric still needs record_evidence. Then run task_acceptance and report that verdict. Do not claim the goal is done before it passes.',
  ].join('\n');
}

function executionPrompt(goal: string, taskId: string, round: number): string {
  const evidenceLine =
    round === 1
      ? 'Work through the short plan. run_tests, verify_fix, or the acceptance command records tests_pass, build_ok, or typecheck_ok. Use record_evidence for any other metric — real probes only, no asserted values.'
      : 'Continue from where you left off. Re-run the failing check so tests_pass, build_ok, or typecheck_ok stay current, and record_evidence again for any other metric (latest evidence per metric wins).';
  return [
    '[task-phase:executing]',
    `Continue the same goal: implement, then verify. Goal: ${goal}`,
    `task_id: ${taskId} — pass it to record_evidence / task tools.`,
    evidenceLine,
    'When the acceptance items are covered, run task_acceptance and report its verdict verbatim.',
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
    '[task-phase:repairing]',
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
    '4. Re-run the failing check. That refreshes tests_pass, build_ok, or typecheck_ok. record_evidence with task_id for any other metric the run does not cover.',
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

function readAgentTurnResult(
  value: string | AgentTurnResult,
  runTurn: TaskEngineDeps['runTurn']
): AgentTurnResult {
  if (typeof value !== 'string') {
    const text = typeof value.text === 'string' ? value.text : '';
    return typeof value.stopReason === 'string' ? { text, stopReason: value.stopReason } : { text };
  }
  const attached = (runTurn as { stopReason?: unknown }).stopReason;
  return typeof attached === 'string' ? { text: value, stopReason: attached } : { text: value };
}

/**
 * Run one agent turn. Order after the turn:
 * settled (accepted, failed, abandoned, blocked) is kept — `task_failed`
 * from there throws and the catch would report "run crashed";
 * Esc returns ok so the caller continues to the loop top, which records
 * aborted; a `budget_*` stop records the failure and does not open another turn.
 */
async function runAgentTurn(
  deps: TaskEngineDeps,
  state: RunLoopState,
  prompt: string,
  phase: string
): Promise<'ok' | 'budget'> {
  const { stopReason } = readAgentTurnResult(await deps.runTurn(prompt, phase), deps.runTurn);
  const snapshot = await getTaskStateSnapshot(deps.workspaceDir, state.taskId);
  if (phaseIsSettled(snapshot?.phase) || deps.signal?.aborted) return 'ok';
  if (!stopReason?.startsWith('budget_')) return 'ok';
  await appendTaskEvent(deps.workspaceDir, state.taskId, 'task_failed', {
    detail: `run budget exceeded (${stopReason})`,
  });
  return 'budget';
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
    // Settled before abort: a turn can accept (or /goal clear) and the user
    // can press Esc in the same beat. Writing task_failed from a terminal
    // phase throws, and /goal reports "run crashed" for a task that finished.
    const current = await getTaskStateSnapshot(workspaceDir, state.taskId);
    if (!current) return 'failed';
    if (phaseIsSettled(current.phase)) return settledLoopOutcome(current.phase);
    if (deps.signal?.aborted) {
      await appendTaskEvent(workspaceDir, state.taskId, 'task_failed', { detail: 'aborted' });
      return 'failed';
    }

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
    const executed = await runAgentTurn(
      deps,
      state,
      executionPrompt(current.goal ?? '', state.taskId, state.repairsUsed + 1),
      'executing'
    );
    if (executed === 'budget') return 'budget';

    // The turn may already have accepted, failed, abandoned, or blocked the
    // task (task_acceptance, /goal clear). Do not reopen it with
    // verification_started — that would bump the attempt and, on a failing
    // command, fall into repair.
    const afterExecution = await getTaskStateSnapshot(workspaceDir, state.taskId);
    // Loop top returns the settled outcome before it consults abort. An Esc
    // during this turn returns normally; continuing into verification and then
    // a repair turn would throw on the already-aborted signal and resumeTask
    // would record that as "run crashed".
    if (phaseIsSettled(afterExecution?.phase) || deps.signal?.aborted) continue;

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
        acceptanceSource: verdict.source,
      });
      deps.onProgress?.({
        taskId: state.taskId,
        phase: 'accepted',
        turn: state.turns,
        detail: 'acceptance passed',
      });
      return 'accepted';
    }

    // Esc during acceptance is not a failed verdict. Do not write
    // acceptance_fail; the loop top records aborted.
    if (deps.signal?.aborted) continue;

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
    const repaired = await runAgentTurn(
      deps,
      state,
      repairPrompt(
        current?.goal ?? '',
        verdict.detail,
        state.repairsUsed,
        repairHistoryFrom(historySnapshot)
      ),
      'repairing'
    );
    if (repaired === 'budget') return 'budget';
    // task_acceptance during the repair turn can accept the task. repair_applied
    // is illegal from a terminal or blocked phase and would surface as
    // "run crashed" even though the goal already finished.
    const afterRepair = await getTaskStateSnapshot(workspaceDir, state.taskId);
    // Same as the execution turn: Esc after acceptance must not append task_failed.
    // Esc during the repair turn itself goes back to the top and records aborted.
    if (phaseIsSettled(afterRepair?.phase) || deps.signal?.aborted) continue;
    await appendTaskEvent(workspaceDir, state.taskId, 'repair_applied', {
      detail: `repair attempt ${state.repairsUsed}`,
    });
  }
}

function phaseIsSettled(phase: TaskStateSnapshot['phase'] | undefined): boolean {
  return phase === 'blocked' || (phase !== undefined && isTerminalTaskPhase(phase));
}

function outcomeFromSnapshot(
  snapshot: TaskStateSnapshot,
  events: Awaited<ReturnType<typeof listTaskEvents>>
): TaskRunResult['outcome'] {
  if (snapshot.phase === 'accepted') return 'pass';
  if (snapshot.phase === 'blocked') return 'blocked';
  if (latestTaskFailureDetail(events) === 'aborted') return 'aborted';
  return 'fail';
}

/** Esc: mark a live task failed with detail `aborted` so /goal resume can re-enter. */
async function failAborted(workspaceDir: string, taskId: string): Promise<void> {
  const current = await getTaskStateSnapshot(workspaceDir, taskId);
  if (!current || phaseIsSettled(current.phase)) return;
  await appendTaskEvent(workspaceDir, taskId, 'task_failed', { detail: 'aborted' });
}

function isUserAbort(err: unknown): boolean {
  if (err instanceof MossError && err.code === ErrorCode.USER_ABORTED) return true;
  return err instanceof Error && err.name === 'AbortError';
}

function settledLoopOutcome(phase: TaskStateSnapshot['phase']): 'accepted' | 'failed' | 'blocked' {
  if (phase === 'accepted') return 'accepted';
  if (phase === 'blocked') return 'blocked';
  return 'failed';
}

function isTaskEventLockTimeout(err: unknown): boolean {
  return err instanceof MossError && err.code === ErrorCode.EXECUTION_LEASE_HELD;
}

async function buildRunResult(
  workspaceDir: string,
  taskId: string,
  state: RunLoopState
): Promise<TaskRunResult> {
  const snapshot = await getTaskStateSnapshot(workspaceDir, taskId);
  if (!snapshot) throw new Error(`task ${taskId} disappeared from the store`);
  const events = await listTaskEvents(workspaceDir, taskId);
  const outcome = outcomeFromSnapshot(snapshot, events);
  return {
    snapshot,
    outcome,
    ...(state.lastVerdict ? { verdictDetail: state.lastVerdict.detail } : {}),
    timeline: formatTaskTimeline(buildTaskTimeline(events)),
    turns: state.turns,
  };
}

/**
 * plan_ready / execution_started are illegal once the task is terminal or
 * blocked (the turn accepted, or another session ran /goal clear). That case
 * is skipped. Any other illegal transition is logged and thrown.
 */
async function appendUnlessAccepted(
  workspaceDir: string,
  taskId: string,
  type: 'plan_ready' | 'execution_started'
): Promise<void> {
  const snapshot = await getTaskStateSnapshot(workspaceDir, taskId);
  if (phaseIsSettled(snapshot?.phase)) return;
  try {
    await appendTaskEvent(workspaceDir, taskId, type);
  } catch (err) {
    if (err instanceof MossError && err.code === ErrorCode.EXECUTION_STATE_INVALID) {
      log.warn('refusing illegal task phase transition', {
        taskId,
        type,
        phase: snapshot?.phase,
        message: err.message,
      });
    }
    throw err;
  }
}

/**
 * The planning turn already implements and verifies. If that work satisfies
 * acceptance, do not spend a second model turn on executionPrompt.
 * A command is not run here unless the contract is already satisfied — a red
 * command would only run again after the execution turn. A failing check is
 * not recorded here; the repair loop still owns the first red verdict.
 */
async function acceptPlanningIfSatisfied(
  deps: TaskEngineDeps,
  state: RunLoopState,
  provider: VerdictProvider
): Promise<boolean> {
  const current = await getTaskStateSnapshot(deps.workspaceDir, state.taskId);
  if (!current || current.phase === 'accepted') return current?.phase === 'accepted';
  if (!(await acceptanceAlreadySatisfied(deps.workspaceDir, state.taskId))) return false;
  const verdict = await provider.evaluate(state.taskId, deps.signal);
  if (!verdict.passed) return false;
  state.lastVerdict = verdict;
  deps.onProgress?.({
    taskId: state.taskId,
    phase: 'verifying',
    turn: state.turns,
    detail: 'evaluating acceptance',
  });
  await emitAcceptanceLifecycle(
    deps.workspaceDir,
    state.taskId,
    true,
    verdict.detail,
    verdict.source
  );
  deps.onProgress?.({
    taskId: state.taskId,
    phase: 'accepted',
    turn: state.turns,
    detail: 'acceptance passed',
  });
  return true;
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
    ...(options.acceptanceCommand ? { acceptanceCommand: options.acceptanceCommand } : {}),
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
    const prompt = planningPrompt(goal, taskId, options.acceptanceCommand, options.capabilityLayer);
    const planning = await runAgentTurn(
      deps,
      state,
      await injectExperienceIntoPrompt(prompt, goal, deps.workspaceDir),
      'planning'
    );
    // A budget stop must not open the execution or repair loop. A settled
    // turn is not a budget stop. An aborted planning turn returns normally;
    // do not hand off into execution or a repair turn.
    if (planning !== 'budget') {
      if (deps.signal?.aborted) {
        await failAborted(deps.workspaceDir, taskId);
        return buildRunResult(deps.workspaceDir, taskId, state);
      }
      // Already-accepted is the only skipped transition. Anything else illegal
      // (for example plan_ready from verifying) throws.
      await appendUnlessAccepted(deps.workspaceDir, taskId, 'plan_ready');
      await appendUnlessAccepted(deps.workspaceDir, taskId, 'execution_started');
      if (deps.signal?.aborted) {
        await failAborted(deps.workspaceDir, taskId);
        return buildRunResult(deps.workspaceDir, taskId, state);
      }
      if (!(await acceptPlanningIfSatisfied(deps, state, provider))) {
        await verifyRepairLoop(deps, state, provider, maxRepairAttempts);
      }
    }
  } catch (err) {
    // A lock timeout is the error: wrapping it as task_failed "run crashed"
    // hides the cause, and the wrap needs the same lock. A user abort is
    // the same class of non-crash: the task stays resumable.
    if (isUserAbort(err) || deps.signal?.aborted) {
      await failAborted(deps.workspaceDir, taskId);
      return buildRunResult(deps.workspaceDir, taskId, state);
    }
    if (!isTaskEventLockTimeout(err)) {
      // A crashed run must stay resumable: mark the task failed (valid from any
      // live phase) instead of leaving it stuck in planning/executing where
      // `resumeTask` refuses to re-enter.
      await tryAppendTaskEvent(deps.workspaceDir, taskId, 'task_failed', {
        detail: `run crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      });
    }
    throw err;
  }
  return buildRunResult(deps.workspaceDir, taskId, state);
}

/**
 * Resume a task and run the same verify→repair cycle from current state (no
 * new planning turns). Failed, abandoned, and blocked tasks re-enter through
 * `task_resumed`. A lock timeout cannot write that event, so a task left in
 * executing (or any other live phase) is resumed in place.
 */
export async function resumeTask(deps: TaskEngineDeps, taskId: string): Promise<TaskRunResult> {
  const snapshot = await getTaskStateSnapshot(deps.workspaceDir, taskId);
  if (!snapshot) throw new Error(`task ${taskId} not found`);
  if (snapshot.phase === 'accepted') throw new Error(`task ${taskId} is already accepted`);
  if (!isResumableTaskPhase(snapshot.phase)) {
    throw new Error(`task ${taskId} is ${snapshot.phase}; nothing to resume`);
  }
  if (
    snapshot.phase === 'failed' ||
    snapshot.phase === 'abandoned' ||
    snapshot.phase === 'blocked'
  ) {
    await appendTaskEvent(deps.workspaceDir, taskId, 'task_resumed', { detail: 'resumed by user' });
  }
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
    if (isUserAbort(err) || deps.signal?.aborted) {
      await failAborted(deps.workspaceDir, taskId);
      return buildRunResult(deps.workspaceDir, taskId, state);
    }
    if (!isTaskEventLockTimeout(err)) {
      await tryAppendTaskEvent(deps.workspaceDir, taskId, 'task_failed', {
        detail: `run crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      });
    }
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
 * outcome token (PASS/FAIL/BLOCKED/ABORTED), task id, counts, and the verdict/timeline
 * bodies stay verbatim. Core cannot read the CLI locale (layering), so the
 * caller passes it in — undefined keeps the English default for SDK callers.
 */
export function summarizeTaskRun(result: TaskRunResult, locale?: string): string {
  const zh = typeof locale === 'string' && /^zh/i.test(locale);
  const { snapshot, outcome, verdictDetail, timeline, turns } = result;
  // Esc keeps the state-machine phase `failed` so /goal resume can re-enter.
  // The status the user reads says aborted, once, and names only /goal resume.
  const phaseLabel = outcome === 'aborted' ? (zh ? '已中止' : 'aborted') : snapshot.phase;
  const lines = zh
    ? [
        `任务 ${snapshot.taskId} — ${outcome.toUpperCase()}`,
        `目标: ${snapshot.goal}`,
        `阶段: ${phaseLabel} · 尝试: ${snapshot.attempt} · 修复: ${snapshot.repairs.length} · 失败: ${snapshot.failures.length} · 轮次: ${turns}`,
      ]
    : [
        `Task ${snapshot.taskId} — ${outcome.toUpperCase()}`,
        `goal: ${snapshot.goal}`,
        `phase: ${phaseLabel} · attempts: ${snapshot.attempt} · repairs: ${snapshot.repairs.length} · failures: ${snapshot.failures.length} · turns: ${turns}`,
      ];
  if (outcome === 'aborted') lines.push('/goal resume');
  if (verdictDetail) lines.push('', zh ? '最终裁决:' : 'Final verdict:', verdictDetail);
  const tail = timeline.split('\n').slice(-6).join('\n');
  if (tail) lines.push('', zh ? '时间线（末尾）:' : 'Timeline (tail):', tail);
  return lines.join('\n');
}
