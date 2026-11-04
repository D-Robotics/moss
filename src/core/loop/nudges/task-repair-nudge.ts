/**
 * TaskRepairNudge — mid-run recovery after a red task_acceptance verdict.
 *
 * RedVerifyNudge covers suite-shaped verification tools (run_tests /
 * test-shaped exec) but NOT the task
 * runtime's own acceptance gate. A FAIL task_acceptance verdict with no
 * successful repair-path activity for that task after it (record_failure /
 * record_repair / record_evidence carrying its task_id)
 * means the agent is drifting away from the diagnose→repair→reverify loop
 * — the most expensive round waste on failure-repair tasks. This nudge
 * fires at most twice per red wave with the exact loop discipline
 * (hypothesis first), and after a re-fail with a repair already on record
 * it demands a DIFFERENT root-cause hypothesis instead of letting the model
 * re-apply the same fix.
 *
 * Verdicts are tracked PER TASK (task id parsed from the verdict text), so
 * a PASS verdict on task A never masks a pending FAIL on task B — repair
 * activity is likewise attributed through the tools' task_id input.
 *
 * Known limitations (re-check if this nudge is reworked; there is no spec suite
 * as of 2026-11-04):
 * - a successful record_evidence after a FAIL silences the wave for that task
 *   (evidence is legitimate progress: latest evidence per metric wins);
 * - a PARTIAL verdict (optional criteria unmet) is not treated as red.
 *
 * Soft: never blocks completion; with no pending FAIL left, a PASS verdict
 * resets the counter.
 */
import type { Message } from '../../session/session-jsonl.js';
import { parseAcceptanceVerdictText } from '../acceptance-verdict-text.js';

const ACCEPTANCE_TOOL = 'task_acceptance';
/** Successful tool results that count as progress through the repair loop. */
const REPAIR_PATH_TOOLS = new Set(['record_failure', 'record_repair', 'record_evidence']);

/** Max fires per red wave; a PASS verdict resets the counter. */
export const TASK_REPAIR_NUDGE_MAX_ATTEMPTS = 2;

export interface TaskRepairNudgeRequest {
  messages: Message[];
  attempts: number;
}

export type TaskRepairNudgeResult =
  | { fire: false; resetAttempts?: boolean }
  | { fire: true; correction: string; resetAttempts?: boolean };

interface RepairEvent {
  name: string;
  /** Monotonic position across the whole message list. */
  order: number;
  taskId: string;
}

interface AcceptanceResultEvent {
  taskId: string;
  outcome: 'FAIL' | 'PASS' | 'PARTIAL';
  order: number;
}

function toolResultText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { content?: unknown; text?: string };
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && typeof (c as { text?: string }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  if (typeof b.text === 'string') return b.text;
  return '';
}

function taskFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as { task_id?: unknown }).task_id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

interface ScanState {
  repairs: RepairEvent[];
  /** Every acceptance result in order (latest per task derived by caller). */
  acceptanceResults: AcceptanceResultEvent[];
}

function scanMessages(messages: Message[]): ScanState {
  const calls = new Map<string, { name: string; taskId: string | undefined }>();
  const repairs: RepairEvent[] = [];
  const acceptanceResults: AcceptanceResultEvent[] = [];
  let order = 0;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || !Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      for (const block of m.content) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string')
          continue;
        calls.set(b.id, { name: b.name, taskId: taskFromToolInput(b.input) });
      }
    } else if (m.role === 'user') {
      for (const block of m.content) {
        const b = block as {
          type?: string;
          name?: string;
          tool_name?: string;
          toolName?: string;
          tool_use_id?: string;
          toolCallId?: string;
          is_error?: boolean;
          isError?: boolean;
          outcome?: string;
          aborted?: unknown;
          _synthetic?: string;
        };
        if (!b || b.type !== 'tool_result') continue;
        const useId = b.tool_use_id ?? b.toolCallId ?? '';
        const call = calls.get(useId);
        const name = call?.name ?? b.name ?? b.tool_name ?? b.toolName;
        order += 1;
        if (
          b.aborted ||
          b._synthetic === 'missing_tool_result' ||
          (b.outcome !== undefined && b.outcome !== 'ok' && b.outcome !== 'error')
        )
          continue;
        const failed =
          b.is_error === true ||
          b.isError === true ||
          (b.outcome !== undefined && b.outcome !== 'ok');
        if (name === ACCEPTANCE_TOOL) {
          const verdict = parseAcceptanceVerdictText(toolResultText(b), call?.taskId);
          // A completed failing verdict can also be marked as a tool error when
          // its command output contains failure banners. Never treat an errored
          // result as PASS or PARTIAL, but retain its attributable FAIL.
          if (verdict && (!failed || verdict.outcome === 'FAIL')) {
            acceptanceResults.push({
              ...verdict,
              order,
            });
          }
        } else if (!failed && call?.taskId && REPAIR_PATH_TOOLS.has(call.name)) {
          repairs.push({ name: call.name, taskId: call.taskId, order });
        }
      }
    }
  }
  return { repairs, acceptanceResults };
}

/** Latest acceptance verdict per task id (empty id = unattributable). */
function latestAcceptanceByTask(
  acceptanceResults: AcceptanceResultEvent[]
): Map<string, AcceptanceResultEvent> {
  const byTask = new Map<string, AcceptanceResultEvent>();
  for (const result of acceptanceResults) byTask.set(result.taskId, result);
  return byTask;
}

function enterLoopCorrection(taskId: string): string {
  return (
    '[System] task_acceptance returned FAIL for ' +
    taskId +
    ' and no repair work has happened for it since. Do not drift — enter the repair loop now:\n' +
    '1. Diagnose BEFORE editing: form a root-cause hypothesis you can check, and probe the failing system to confirm it.\n' +
    '2. record_failure with the symptom + your diagnosis (include task_id).\n' +
    '3. Apply the minimal fix; record_repair with what you changed (include task_id).\n' +
    '4. Re-measure and record fresh evidence for the failing metrics (record_evidence with task_id) — latest evidence per metric wins.\n' +
    '5. Re-run task_acceptance; only its PASS verdict closes the task.'
  );
}

function retryDifferentCorrection(taskId: string, repairs: number): string {
  const noun = repairs === 1 ? 'repair' : 'repairs';
  return (
    '[System] task_acceptance for ' +
    taskId +
    ' FAILED again after ' +
    repairs +
    ' recorded ' +
    noun +
    '. Do NOT repeat them — re-applying the same fix cannot change the verdict; it addressed the wrong cause.\n' +
    '1. Re-read the failing criteria in the verdict and form a DIFFERENT root-cause hypothesis; confirm it with a probe before editing.\n' +
    '2. Update the failure record (record_failure with the new diagnosis), apply a different minimal fix, record_repair.\n' +
    '3. Re-measure, record fresh evidence for the failing metrics (record_evidence), then re-run task_acceptance.'
  );
}

/**
 * Mid-run nudge when a task's LATEST acceptance verdict is FAIL and the
 * agent has made no repair-path progress for that task since. Verdicts are
 * tracked per task, so a later PASS on another task cannot mask a pending
 * FAIL. With no pending FAIL left, a PASS verdict resets the attempts
 * counter so a later red wave can fire again.
 */
export function evaluateTaskRepairNudge(request: TaskRepairNudgeRequest): TaskRepairNudgeResult {
  const { repairs, acceptanceResults } = scanMessages(request.messages);
  if (acceptanceResults.length === 0) return { fire: false };

  const byTask = latestAcceptanceByTask(acceptanceResults);
  const pendingFails = [...byTask.values()].filter(
    (result) =>
      result.outcome === 'FAIL' &&
      !repairs.some((repair) => repair.order > result.order && repair.taskId === result.taskId)
  );

  if (pendingFails.length === 0) {
    // No task is waiting on repair. A PASS verdict (the loop closed
    // cleanly) resets the wave counter; unknown/partial verdicts do not.
    const sawPass = [...byTask.values()].some((result) => result.outcome === 'PASS');
    if (sawPass && request.attempts > 0) return { fire: false, resetAttempts: true };
    return { fire: false };
  }

  if (request.attempts >= TASK_REPAIR_NUDGE_MAX_ATTEMPTS) return { fire: false };

  // Most recent pending FAIL wins when several tasks wait at once.
  const target = pendingFails.reduce((a, b) => (b.order > a.order ? b : a));
  const repairsBeforeFail = repairs.filter(
    (repair) =>
      repair.order < target.order &&
      repair.name === 'record_repair' &&
      repair.taskId === target.taskId
  ).length;

  return {
    fire: true,
    correction:
      repairsBeforeFail > 0
        ? retryDifferentCorrection(target.taskId, repairsBeforeFail)
        : enterLoopCorrection(target.taskId),
  };
}
