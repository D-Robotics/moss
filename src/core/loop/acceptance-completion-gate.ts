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
  | { ok: false; reason: string; correction: string; retryLimit: 1 };

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
  const verdicts = collectToolResultsByName(request.messages, 'task_acceptance');
  if (verdicts.some((text) => text.includes(TASK_ACCEPTANCE_PASS_MARKER))) {
    return { ok: true };
  }
  if (verdicts.length > 0) {
    // Acceptance ran and failed — allow completion; the final answer must
    // carry the honest FAIL verdict that is already in context.
    return { ok: true };
  }
  return {
    ok: false,
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
  let blockedOnce = false;
  return async (request) => {
    if (blockedOnce) return { ok: true as const };
    const decision = evaluateAcceptanceCompletionGate(request);
    if (!decision.ok && options.workspaceDir) {
      const settled = await runtimeHasSettledAcceptance(options.workspaceDir);
      if (settled) return { ok: true as const };
    }
    if (!decision.ok) {
      blockedOnce = true;
      return decision;
    }
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
