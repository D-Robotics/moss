/**
 * SubagentStoppedNudge — mid-run reminder after subagent_stop without suite evidence.
 *
 * Stopping a background child is not proof the task is fixed. Soft: max 1 fire.
 * Pairs with evaluateRunningBackgroundSubagentGate end-of-turn stop≠success.
 */
import type { Message } from '../session/session-jsonl.js';

export const SUBAGENT_STOPPED_NUDGE_MAX_ATTEMPTS = 1;

export interface SubagentStoppedNudgeRequest {
  messages: Message[];
  toolCallsByName: Record<string, number>;
  attempts: number;
}

export type SubagentStoppedNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function toolResultText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: string; content?: unknown; text?: string };
  if (b.type !== 'tool_result') return '';
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

function toolUseNameById(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

/** True when a recent subagent_stop shows STOPPED / STOP REQUESTED / ALREADY cancelled. */
export function hasRecentSubagentStop(messages: Message[]): boolean {
  const nameById = toolUseNameById(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
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
        b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      if (name !== 'subagent_stop') continue;
      const text = toolResultText(b);
      if (/\]\s*(?:STOPPED|STOP REQUESTED|ALREADY\s+\w+)/i.test(text)) return true;
    }
  }
  return false;
}

export function evaluateSubagentStoppedNudge(
  request: SubagentStoppedNudgeRequest,
): SubagentStoppedNudgeResult {
  if (request.attempts >= SUBAGENT_STOPPED_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if ((request.toolCallsByName.subagent_stop ?? 0) === 0) return { fire: false };
  if ((request.toolCallsByName.run_tests ?? 0) > 0 || (request.toolCallsByName.verify_fix ?? 0) > 0) {
    return { fire: false };
  }
  if (!hasRecentSubagentStop(request.messages)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] You stopped a background sub-agent (`subagent_stop`). That cancels the child — it is **not** proof the task is fixed.\n' +
      'Next: re-run the child to completion, run `run_tests`/`verify_fix` yourself, or explicitly treat the work as cancelled/incomplete. ' +
      'Do not invent a successful fix from a stopped sub-agent.',
  };
}
