/**
 * FanOutNudge — mid-run recovery after a failed fan_out / create_subagent.
 *
 * End-of-turn evaluateFanOutMergeGate only fires when the model claims done.
 * This soft nudge fires once after tools when the latest subagent aggregation
 * failed, so the parent re-runs failed angles or merges only successes before
 * more unrelated work.
 */
import type { Message } from '../session/session-jsonl.js';

export const FAN_OUT_NUDGE_MAX_ATTEMPTS = 1;

export interface FanOutNudgeRequest {
  messages: Message[];
  attempts: number;
}

export type FanOutNudgeResult =
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

function isFailedFanOutResult(name: string, text: string, isError: boolean): boolean {
  if (name !== 'fan_out_subagents' && name !== 'create_subagent') return false;
  if (isError) return true;
  if (/Error:\s*\[fan_out_subagents\]/i.test(text)) return true;
  if (/\b\d+\s+ok,\s*[1-9]\d*\s+failed\b/i.test(text)) return true;
  if (/\[Sub-agent[^\]]*\]\s*FAILED/i.test(text)) return true;
  if (/empty output treated as failure/i.test(text)) return true;
  if (/## Retry failed angles/i.test(text)) return true;
  return false;
}

/**
 * Latest fan_out / create_subagent tool_result that indicates child failure.
 */
export function findLatestFailedFanOut(messages: Message[]): { name: string; text: string } | null {
  const nameById = toolUseNameById(messages);
  let latest: { name: string; text: string } | null = null;

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
        is_error?: boolean;
        isError?: boolean;
        outcome?: string;
      };
      if (!b || b.type !== 'tool_result') continue;
      const useId = b.tool_use_id ?? b.toolCallId ?? '';
      const name =
        b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      const text = toolResultText(b);
      const flaggedError =
        b.is_error === true ||
        b.isError === true ||
        b.outcome === 'error' ||
        b.outcome === 'blocked' ||
        b.outcome === 'denied';
      if (!isFailedFanOutResult(name, text, flaggedError)) continue;
      latest = { name, text };
    }
  }
  return latest;
}

export function evaluateFanOutNudge(request: FanOutNudgeRequest): FanOutNudgeResult {
  if (request.attempts >= FAN_OUT_NUDGE_MAX_ATTEMPTS) return { fire: false };

  const hit = findLatestFailedFanOut(request.messages);
  if (!hit) return { fire: false };

  const preview = hit.text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, 6)
    .join('\n');

  return {
    fire: true,
    correction:
      `[System] Latest \`${hit.name}\` has FAILED or empty children. Do not invent overall success.\n` +
      `Excerpt:\n${preview}\n` +
      'Next: merge only SUCCESS evidence; re-run FAILED angles via create_subagent or a smaller fan_out ' +
      '(use the Retry failed angles block if present; prefer scope full/verify for implement/fix). ' +
      'Then continue with the parent task.',
  };
}
