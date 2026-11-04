/**
 * Plan-mode end protocol (backlog B04).
 *
 * Cursor/Claude Code make "this turn submits an approvable plan" a hard
 * contract: the turn ends with `ExitPlanMode` (or a concrete question), not
 * with prose asking "shall I proceed?". Moss had the `exit_plan` tool and its
 * version fingerprint, but nothing required it: a plan-mode turn that read a
 * file and then answered in prose ended with no submitted plan, so the user had
 * nothing to approve and the TUI's approval receipt had to invent a fallback
 * version hash.
 *
 * The rule is deliberately narrow, mirroring the acceptance gates:
 * - only in plan mode;
 * - only for turns that did real work (`totalToolCalls > 0`), so plain
 *   read-only questions and greetings are never forced into a fake plan;
 * - a submitted `exit_plan` (or a question awaiting the user) satisfies it;
 * - fires at most once per run — bounded correction, never a loop.
 */
import type { Message } from '../session/session-jsonl.js';
import type { AgentLoopExtensions } from './agent-loop-types.js';

interface RecordedCall {
  name: string;
  isError: boolean;
  resultText: string;
}

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

function collectCalls(messages: readonly Message[]): RecordedCall[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; tool_use_id?: string; is_error?: boolean };
      if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue;
      results.set(typed.tool_use_id, {
        text: toolResultText(block as { content?: unknown }),
        isError: typed.is_error === true,
      });
    }
  }
  const calls: RecordedCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; id?: string; name?: string };
      if (typed.type !== 'tool_use' || typeof typed.name !== 'string') continue;
      const result = typeof typed.id === 'string' ? results.get(typed.id) : undefined;
      calls.push({
        name: typed.name,
        isError: result?.isError ?? false,
        resultText: result?.text ?? '',
      });
    }
  }
  return calls;
}

export interface PlanEndProtocolDecision {
  ok: boolean;
  reason: string;
  correction?: string;
}

/** Contract text shared by the prompt layer and the gate correction. */
export const PLAN_END_CORRECTION =
  'Plan mode requires an approvable plan before the turn ends. Restate the plan concisely and call ' +
  'exit_plan with its one-paragraph summary so the user can approve that specific version — do not just ' +
  'ask "shall I proceed?" in prose, and do not edit files. If a decision is genuinely required from the ' +
  'user before a plan exists, ask one concrete question instead.';

export function evaluatePlanEndProtocol(
  request: { messages: readonly Message[]; totalToolCalls: number },
  planMode: boolean
): PlanEndProtocolDecision {
  if (!planMode) return { ok: true, reason: 'not in plan mode' };
  if (request.totalToolCalls === 0) {
    return { ok: true, reason: 'no tool work happened, so there is no plan to submit' };
  }
  const calls = collectCalls(request.messages);
  if (calls.some((call) => call.name === 'exit_plan' && !call.isError)) {
    return { ok: true, reason: 'the plan was submitted with exit_plan' };
  }
  // A concrete question awaiting the user is the other legitimate ending.
  if (calls.some((call) => call.name === 'ask_user_question' && !call.isError)) {
    return { ok: true, reason: 'the turn ended by asking the user' };
  }
  return {
    ok: false,
    reason: 'plan mode did real work but never submitted the plan',
    correction: PLAN_END_CORRECTION,
  };
}

export function createPlanCompletionGate(options: {
  planModeActive: () => boolean;
}): NonNullable<AgentLoopExtensions['completionGate']> {
  // One ceiling like the other completion gates; this rule fires at most once.
  const GATE_RETRY_CEILING = 6;
  let held = false;
  return async (request) => {
    const decision = evaluatePlanEndProtocol(request, options.planModeActive());
    if (decision.ok) return { ok: true as const };
    if (held) return { ok: true as const };
    held = true;
    return {
      ok: false as const,
      reason: decision.reason,
      ...(decision.correction ? { correction: decision.correction } : {}),
      retryLimit: GATE_RETRY_CEILING,
    };
  };
}
