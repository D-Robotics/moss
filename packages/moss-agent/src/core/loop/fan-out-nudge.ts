/**
 * FanOutNudge — mid-run recovery after fan_out / create_subagent.
 *
 * 1) Failed / empty children → re-run or merge only SUCCESS (pairs with end-of-turn merge gate).
 * 2) "Success" children on fix/implement without suite green in summaries → parent must run tests
 *    (pairs with end-of-turn delegated-mutation gate).
 *
 * Soft: max 1 fire per agent run.
 */
import type { Message } from '../session/session-jsonl.js';

export const FAN_OUT_NUDGE_MAX_ATTEMPTS = 1;

const FIX_OR_IMPLEMENT_RE =
  /(?:fix|bug|implement|refactor|repair|patch|报错|失败|崩溃|exception|error|错误|修复|修一下|实现|重构)/iu;

const DELEGATED_RUNTIME_GREEN_RE =
  /Test Results:\s*✅\s*ALL PASSED|Verify Fix:\s*✅\s*ALL PASSED|Tests:\s*✅\s*pass|ℹ\s*pass\s+[1-9]\d*/i;

export interface FanOutNudgeRequest {
  messages: Message[];
  attempts: number;
  /** Latest real user text — used for fix/implement suite-evidence branch. */
  userText?: string;
  toolCallsByName?: Record<string, number>;
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

/**
 * Latest non-error fan_out / create_subagent result (for suite-evidence branch).
 */
export function findLatestOkSubagentAggregation(
  messages: Message[],
): { name: string; text: string } | null {
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
      if (name !== 'fan_out_subagents' && name !== 'create_subagent') continue;
      const text = toolResultText(b);
      const flaggedError =
        b.is_error === true ||
        b.isError === true ||
        b.outcome === 'error' ||
        b.outcome === 'blocked' ||
        b.outcome === 'denied';
      if (isFailedFanOutResult(name, text, flaggedError)) continue;
      latest = { name, text };
    }
  }
  return latest;
}

export function evaluateFanOutNudge(request: FanOutNudgeRequest): FanOutNudgeResult {
  if (request.attempts >= FAN_OUT_NUDGE_MAX_ATTEMPTS) return { fire: false };

  const failed = findLatestFailedFanOut(request.messages);
  if (failed) {
    const preview = failed.text
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0)
      .slice(0, 6)
      .join('\n');

    return {
      fire: true,
      correction:
        `[System] Latest \`${failed.name}\` has FAILED or empty children. Do not invent overall success.\n` +
        `Excerpt:\n${preview}\n` +
        'Next: merge only SUCCESS evidence; re-run FAILED angles via create_subagent or a smaller fan_out ' +
        '(use the Retry failed angles block if present; prefer scope full/verify for implement/fix). ' +
        'Then continue with the parent task.',
    };
  }

  // Success path without suite evidence on fix/implement — mid-run pressure.
  const user = (request.userText || '').trim();
  if (!user || !FIX_OR_IMPLEMENT_RE.test(user)) return { fire: false };
  if (/(?:不要跑测试|跳过测试|skip\s+tests?)/iu.test(user)) return { fire: false };

  const byName = request.toolCallsByName ?? {};
  if ((byName.run_tests ?? 0) > 0 || (byName.verify_fix ?? 0) > 0) return { fire: false };

  const ok = findLatestOkSubagentAggregation(request.messages);
  if (!ok) return { fire: false };
  if (DELEGATED_RUNTIME_GREEN_RE.test(ok.text)) return { fire: false };

  // Only nudge when children look like they may have mutated (full/verify scope or fix verbs in body).
  const looksLikeMutation =
    /scope:\s*full|scope:\s*verify|\bfix\b|\bedit\b|\bimplement\b|Edited |Patch applied|write complete|Moved /i.test(
      ok.text,
    );
  if (!looksLikeMutation) return { fire: false };

  return {
    fire: true,
    correction:
      `[System] Latest \`${ok.name}\` reported SUCCESS children for a fix/implement task, but there is no green test suite evidence in the summaries and you have not run \`run_tests\`/\`verify_fix\` on the parent.\n` +
      'Before more work or claiming done: run runtime tests yourself, or re-run children with scope=verify and ensure summaries include Test Results / verify_fix green output. ' +
      'Untested merge prose is not proof the bug is fixed.',
  };
}
