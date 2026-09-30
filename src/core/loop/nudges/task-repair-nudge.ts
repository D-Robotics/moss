/**
 * TaskRepairNudge — mid-run recovery after a red task_acceptance verdict.
 *
 * RedVerifyNudge covers suite-shaped verification tools (run_tests /
 * verify_fix / code_diagnostics / test-shaped exec) but NOT the task
 * runtime's own acceptance gate. A FAIL task_acceptance verdict with no
 * repair-path activity after it (record_failure / record_repair /
 * record_evidence / task_acceptance) means the agent is drifting away from
 * the diagnose→repair→reverify loop — the most expensive round waste on
 * failure-repair tasks. This nudge fires at most twice per red wave with the
 * exact loop discipline (hypothesis first), and after a re-fail with a
 * repair already on record it demands a DIFFERENT root-cause hypothesis
 * instead of letting the model re-apply the same fix.
 *
 * Soft: never blocks completion; a green (PASS) verdict resets the counter.
 */
import type { Message } from '../../session/session-jsonl.js';

const ACCEPTANCE_TOOL = 'task_acceptance';
/** Tool uses that count as real progress through the repair loop. */
const REPAIR_PATH_TOOLS = new Set([
  'record_failure',
  'record_repair',
  'record_evidence',
  'task_acceptance',
]);

/** The contract verdict format (contracts/task.ts formatAcceptanceVerdict). */
const ACCEPTANCE_FAIL_RE = /^Task acceptance \([^)]*\): FAIL/m;
const ACCEPTANCE_PASS_RE = /^Task acceptance \([^)]*\): PASS/m;

/** Max fires per red wave; a PASS verdict resets the counter. */
export const TASK_REPAIR_NUDGE_MAX_ATTEMPTS = 2;

export interface TaskRepairNudgeRequest {
  messages: Message[];
  attempts: number;
}

export type TaskRepairNudgeResult =
  | { fire: false; resetAttempts?: boolean }
  | { fire: true; correction: string; resetAttempts?: boolean };

interface ToolUseEvent {
  name: string;
  /** Monotonic position across the whole message list. */
  order: number;
}

interface AcceptanceResultEvent {
  outcome: 'fail' | 'pass' | 'unknown';
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

interface ScanState {
  uses: ToolUseEvent[];
  /** Latest acceptance result only — it defines the current wave. */
  latestAcceptance: AcceptanceResultEvent | undefined;
}

function scanMessages(messages: Message[]): ScanState {
  // tool_use id → name, so result blocks without a name still resolve.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        nameById.set(b.id, b.name);
      }
    }
  }

  const uses: ToolUseEvent[] = [];
  let latestAcceptance: AcceptanceResultEvent | undefined;
  let order = 0;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || !Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      for (const block of m.content) {
        const b = block as { type?: string; name?: string };
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        order += 1;
        uses.push({ name: b.name, order });
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
        };
        if (!b || b.type !== 'tool_result') continue;
        const useId = b.tool_use_id ?? b.toolCallId ?? '';
        const name =
          b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined);
        order += 1;
        if (name !== ACCEPTANCE_TOOL) continue;
        const text = toolResultText(b);
        latestAcceptance = {
          outcome: ACCEPTANCE_FAIL_RE.test(text)
            ? 'fail'
            : ACCEPTANCE_PASS_RE.test(text)
              ? 'pass'
              : 'unknown',
          order,
        };
      }
    }
  }
  return { uses, latestAcceptance };
}

const ENTER_LOOP_CORRECTION =
  '[System] task_acceptance returned FAIL and no repair work has happened since. Do not drift — enter the repair loop now:\n' +
  '1. Diagnose BEFORE editing: form a root-cause hypothesis you can check, and probe the failing system to confirm it.\n' +
  '2. record_failure with the symptom + your diagnosis (include task_id).\n' +
  '3. Apply the minimal fix; record_repair with what you changed (include task_id).\n' +
  '4. Re-measure and record fresh evidence for the failing metrics (record_evidence with task_id) — latest evidence per metric wins.\n' +
  '5. Re-run task_acceptance; only its PASS verdict closes the task.';

const RETRY_DIFFERENT_CORRECTION =
  '[System] task_acceptance FAILED again after a recorded repair. Do NOT repeat that repair — re-applying the same fix cannot change the verdict; it addressed the wrong cause.\n' +
  '1. Re-read the failing criteria in the verdict and form a DIFFERENT root-cause hypothesis; confirm it with a probe before editing.\n' +
  '2. Update the failure record (record_failure with the new diagnosis), apply a different minimal fix, record_repair.\n' +
  '3. Re-measure, record fresh evidence for the failing metrics (record_evidence), then re-run task_acceptance.';

/**
 * Mid-run nudge when the latest task_acceptance verdict is FAIL and the
 * agent has made no repair-path progress since. A PASS verdict resets the
 * attempts counter so a later red wave can fire again.
 */
export function evaluateTaskRepairNudge(request: TaskRepairNudgeRequest): TaskRepairNudgeResult {
  const { uses, latestAcceptance } = scanMessages(request.messages);
  if (!latestAcceptance) return { fire: false };

  if (latestAcceptance.outcome !== 'fail') {
    if (latestAcceptance.outcome === 'pass' && request.attempts > 0) {
      return { fire: false, resetAttempts: true };
    }
    return { fire: false };
  }

  const failOrder = latestAcceptance.order;
  const repairActivityAfterFail = uses.some(
    (use) => use.order > failOrder && REPAIR_PATH_TOOLS.has(use.name)
  );
  if (repairActivityAfterFail) return { fire: false };

  if (request.attempts >= TASK_REPAIR_NUDGE_MAX_ATTEMPTS) return { fire: false };

  const repairsBeforeFail = uses.filter(
    (use) => use.order < failOrder && use.name === 'record_repair'
  ).length;

  return {
    fire: true,
    correction: repairsBeforeFail > 0 ? RETRY_DIFFERENT_CORRECTION : ENTER_LOOP_CORRECTION,
  };
}
