/**
 * Shared utilities for nudge modules.
 *
 * Most tool-nudge files follow the same structure: check attempts, check
 * totalToolCalls, check whether a matching exec / tool has already run,
 * match the user's text against a domain regex, optionally filter out
 * conceptual questions, then fire a correction.
 *
 * The helpers below extract the boilerplate that was previously copy-pasted
 * into every nudge file.
 */

/** Tool names that represent command execution (used by ~21 nudge files). */
export const EXEC_TOOLS = new Set(['exec', 'exec_background']);

/** Dedicated verification tools that may already cover a domain check. */
export const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

/** Session message shape used by nudge request interfaces. */
export type NudgeMessage = { role?: string; content?: unknown };

/** Common nudge request shape — individual nudge files re-export with their own name. */
export interface NudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: NudgeMessage[];
  totalToolCalls: number;
  attempts: number;
}

/** Common nudge result shape. */
export type NudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

/**
 * Collect command strings from `exec` / `exec_background` tool_use blocks
 * in assistant messages. Used by every nudge that needs to check whether a
 * domain-specific command has already run.
 */
export function collectExecCommands(
  messages: NudgeMessage[] | undefined,
): string[] {
  if (!messages?.length) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name || !EXEC_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const o = input as Record<string, unknown>;
      for (const key of ['command', 'cmd', 'input'] as const) {
        if (typeof o[key] === 'string' && String(o[key]).trim()) {
          out.push(String(o[key]));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Count how many tool calls (by name) match any name in `names`.
 */
export function countBySet(
  byName: Record<string, number>,
  names: Set<string>,
): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

/** Base regex for detecting conceptual / informational questions. */
const CONCEPTUAL_QUESTION_RE =
  /(?:what is|how does|文档|原理|介绍)/iu;

/**
 * Return true when the user text looks like a conceptual/informational
 * question (e.g. "what is coverage?") rather than an action request.
 *
 * `actionWordsRe` is a domain-specific regex that, when matched, signals
 * the user *is* asking for action — overriding the conceptual filter.
 */
export function isConceptualQuestion(
  user: string,
  actionWordsRe: RegExp,
): boolean {
  return CONCEPTUAL_QUESTION_RE.test(user) && !actionWordsRe.test(user);
}

/**
 * Check whether dedicated verification tools have already run.
 */
export function sawVerifyTools(
  byName: Record<string, number>,
): boolean {
  return countBySet(byName, VERIFY_TOOLS) > 0;
}
