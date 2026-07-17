/**
 * SubagentRunningNudge — mid-run reminder while a background create_subagent
 * is still STARTED without a terminal subagent_status.
 *
 * Pairs with evaluateRunningBackgroundSubagentGate (end-of-turn). Soft: max 1 fire.
 */
import type { Message } from '../session/session-jsonl.js';

export const SUBAGENT_RUNNING_NUDGE_MAX_ATTEMPTS = 1;

export interface SubagentRunningNudgeRequest {
  messages: Message[];
  attempts: number;
}

export type SubagentRunningNudgeResult =
  | { fire: false }
  | { fire: true; correction: string; taskIds: string[] };

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

/** STARTED task ids without a later terminal SUCCESS/FAILED status. */
export function findStillRunningBackgroundSubagentIds(messages: Message[]): string[] {
  const nameById = toolUseNameById(messages);
  const startedIds = new Set<string>();
  const terminalIds = new Set<string>();

  for (const m of messages) {
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
      const text = toolResultText(b);

      if (name === 'create_subagent') {
        const mStart = text.match(/\[Sub-agent task\s+([^\]]+)\]\s*STARTED/i);
        if (mStart?.[1]) startedIds.add(mStart[1].trim());
      }
      if (name === 'subagent_status') {
        const mTerm = text.match(/\[Sub-agent task\s+([^\]]+)\]\s*(?:SUCCESS|FAILED)/i);
        if (mTerm?.[1]) terminalIds.add(mTerm[1].trim());
      }
    }
  }

  return [...startedIds].filter((id) => !terminalIds.has(id));
}

export function evaluateSubagentRunningNudge(
  request: SubagentRunningNudgeRequest,
): SubagentRunningNudgeResult {
  if (request.attempts >= SUBAGENT_RUNNING_NUDGE_MAX_ATTEMPTS) return { fire: false };

  const stillRunning = findStillRunningBackgroundSubagentIds(request.messages);
  if (stillRunning.length === 0) return { fire: false };

  const preview = stillRunning
    .slice(0, 4)
    .map((id) => `- ${id}`)
    .join('\n');

  return {
    fire: true,
    taskIds: stillRunning,
    correction:
      '[System] A background `create_subagent` is still STARTED (no terminal `subagent_status` yet).\n' +
      `Open task id(s):\n${preview}\n` +
      'Before more parent work or claiming done: call `subagent_status` with wait=true (or wait for completion), ' +
      'read SUCCESS/FAILED + evidence, then continue. Do not invent child outcomes while the task is running.',
  };
}
