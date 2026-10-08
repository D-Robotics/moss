/**
 * Acceptance completion gate (robotics closed loop P0-2/P0-9): when the agent
 * defined a task contract this run, the final answer is held back until a
 * recorded acceptance verdict exists. The gate blocks at most once per run —
 * it forces the acceptance/repair loop to actually run, then lets an honest
 * failure report through instead of holding the run hostage.
 */

import type { Message } from '../session/session-jsonl.js';
import type { AgentLoopExtensions } from './agent-loop-types.js';

export const TASK_ACCEPTANCE_VERDICT_MARKER = 'Task acceptance (';
export const TASK_ACCEPTANCE_PASS_MARKER = 'FINAL: PASS';

/** Extract readable text from a tool_result content block. */
function toolResultText(block: { content?: unknown }): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/**
 * Chronological tool results for one tool name, extracted from the message
 * history (assistant tool_use id ↔ user tool_result pairing by order of
 * appearance is unnecessary here: result blocks carry the tool's own output,
 * and the acceptance output is uniquely tagged).
 */
export function collectToolResultsByName(messages: Message[], toolName: string): string[] {
  const results: string[] = [];
  // First pass: tool_use ids for the tool name.
  const useIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_use' &&
        (block as { name?: string }).name === toolName &&
        typeof (block as { id?: string }).id === 'string'
      ) {
        useIds.add((block as { id: string }).id);
      }
    }
  }
  // Second pass: tool_result blocks for those ids, in message order.
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_result' &&
        useIds.has((block as { tool_use_id?: string }).tool_use_id ?? '')
      ) {
        results.push(toolResultText(block as { content?: unknown }));
      }
    }
  }
  return results;
}

export type AcceptanceGateDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      correction: string;
      retryLimit: 1 | 2;
      kind: 'no-verdict' | 'unrepaired-fail';
    };

/** Tools that count as entering the diagnose → repair loop after a FAIL. */
const REPAIR_AFTER_FAIL = new Set(['record_failure', 'record_repair', 'record_evidence']);

function acceptanceOutcome(text: string): 'pass' | 'fail' | 'other' {
  if (text.includes(TASK_ACCEPTANCE_PASS_MARKER)) return 'pass';
  if (/Task acceptance \([^)]*\): FAIL/.test(text)) return 'fail';
  return 'other';
}

/**
 * Latest acceptance verdict, and whether a repair-path tool was invoked
 * after that FAIL result. A PASS, or a FAIL that was followed by repair
 * work, is enough to let the run finish.
 */
function acceptanceProgress(messages: Message[]): {
  outcome: 'none' | 'pass' | 'fail' | 'other';
  repairedAfterFail: boolean;
} {
  let outcome: 'none' | 'pass' | 'fail' | 'other' = 'none';
  let repairedAfterFail = false;
  const acceptanceIds = new Set<string>();
  const repairIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; name?: string; id?: string };
      if (typed.type !== 'tool_use' || typeof typed.id !== 'string') continue;
      if (typed.name === 'task_acceptance') acceptanceIds.add(typed.id);
      if (typed.name && REPAIR_AFTER_FAIL.has(typed.name)) repairIds.add(typed.id);
    }
  }
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; tool_use_id?: string };
      if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue;
      if (acceptanceIds.has(typed.tool_use_id)) {
        outcome = acceptanceOutcome(toolResultText(block as { content?: unknown }));
        repairedAfterFail = false;
      } else if (outcome === 'fail' && repairIds.has(typed.tool_use_id)) {
        repairedAfterFail = true;
      }
    }
  }
  return { outcome, repairedAfterFail };
}

/**
 * Pure decision: block completion only when a task contract was defined this
 * run and no acceptance verdict has been recorded since. A FAIL/PARTIAL
 * verdict counts as recorded — the agent is then expected to report that
 * failure honestly (the verdict text is in its context).
 */
export function evaluateAcceptanceCompletionGate(request: {
  messages: Message[];
  toolCallsByName: Record<string, number>;
}): AcceptanceGateDecision {
  if ((request.toolCallsByName['task_define'] ?? 0) === 0) {
    return { ok: true };
  }
  const progress = acceptanceProgress(request.messages);
  if (progress.outcome === 'pass' || progress.outcome === 'other') {
    return { ok: true };
  }
  if (progress.outcome === 'fail' && progress.repairedAfterFail) {
    return { ok: true };
  }
  if (progress.outcome === 'fail') {
    return {
      ok: false,
      kind: 'unrepaired-fail',
      reason: 'acceptance failed and the repair loop has not started',
      correction:
        'task_acceptance returned FAIL and nothing since has entered the repair loop. ' +
        'Do not end the run on the first red verdict. Record the failure (record_failure), repair the cause, ' +
        'record fresh evidence (record_evidence), then re-run task_acceptance. ' +
        'If the task genuinely cannot pass, record that failure and then report the FAIL honestly — do not claim success.',
      retryLimit: 2,
    };
  }
  return {
    ok: false,
    kind: 'no-verdict',
    reason: 'task contract defined but acceptance never evaluated',
    correction:
      'You defined a task contract (task_define) but the run cannot end before acceptance is evaluated. ' +
      'Run task_acceptance for the task id now. For unmet criteria: record evidence with record_evidence (task_id=...) ' +
      'or repair and re-verify, then re-run task_acceptance. If the task genuinely cannot pass (device unreachable, ' +
      'environment gap), the recorded FAIL verdict is the honest outcome — report it, do not claim success.',
    retryLimit: 1,
  };
}

/**
 * Per-run wrapper: the gate blocks at most once. After one correction the
 * agent may finish (with an acceptance verdict if it complied, or plainly if
 * it could not) — this never escalates into a thrown completion rejection.
 *
 * Task OS M4: with a workspaceDir the gate also consults the unified task
 * runtime — a verdict may have been recorded by the engine (or a settled
 * lifecycle phase reached) even when the message history carries no
 * task_acceptance tool result.
 */
export function createAcceptanceCompletionGate(
  options: { workspaceDir?: string } = {}
): NonNullable<AgentLoopExtensions['completionGate']> {
  let blockedNoVerdict = false;
  let blockedUnrepairedFail = false;
  return async (request) => {
    const decision = evaluateAcceptanceCompletionGate(request);
    if (!decision.ok && options.workspaceDir) {
      const settled = await runtimeHasSettledAcceptance(options.workspaceDir);
      if (settled) return { ok: true as const };
    }
    if (decision.ok) return decision;
    if (decision.kind === 'no-verdict') {
      if (blockedNoVerdict) return { ok: true as const };
      blockedNoVerdict = true;
      return decision;
    }
    if (blockedUnrepairedFail) return { ok: true as const };
    blockedUnrepairedFail = true;
    return decision;
  };
}

/**
 * True when the most recently updated task in the runtime has a recorded
 * acceptance verdict whose latest lifecycle state is terminal — the engine
 * (or an earlier run) already settled acceptance outside this run's context.
 */
async function runtimeHasSettledAcceptance(workspaceDir: string): Promise<boolean> {
  try {
    const { listTaskStateSnapshots } = await import('../task/task-store.js');
    const snapshots = await listTaskStateSnapshots(workspaceDir);
    if (snapshots.length === 0) return false;
    const latest = snapshots.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a));
    return (
      latest.phase === 'accepted' || (latest.lastVerdict !== undefined && latest.phase === 'failed')
    );
  } catch {
    return false;
  }
}
