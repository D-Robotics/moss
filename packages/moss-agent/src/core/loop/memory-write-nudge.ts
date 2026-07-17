/**
 * MemoryWriteNudge — mid-run reminder when the user asked to remember something
 * but memory_write was never called (pairs with evaluateMemoryCompletionGate).
 *
 * Soft: max 1 fire per run; never blocks completion.
 */

export const MEMORY_WRITE_NUDGE_MAX_ATTEMPTS = 1;

/** User asked to persist a durable fact / preference. */
const REMEMBER_USER_RE =
  /(?:\bremember\b|\bstore (?:this|that|in memory)\b|\bsave (?:this|that|to memory)\b|\bkeep in mind\b|记住|记一下|记在记忆|写入记忆|长期记忆)/iu;

export interface MemoryWriteNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  /** At least some tools already ran this turn (avoid pre-tool noise). */
  totalToolCalls: number;
  attempts: number;
}

export type MemoryWriteNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

export function evaluateMemoryWriteNudge(
  request: MemoryWriteNudgeRequest,
): MemoryWriteNudgeResult {
  if (request.attempts >= MEMORY_WRITE_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if ((request.toolCallsByName.memory_write ?? 0) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !REMEMBER_USER_RE.test(user)) return { fire: false };

  // User only asked a question about memory, not to store.
  if (
    /(?:what do you remember|do you remember|有没有记住|记得什么)/iu.test(user) &&
    !/(?:please remember|remember that|记住我|记一下|store this)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked you to remember/store a durable fact, but `memory_write` has not been called this turn. ' +
      'If the fact should persist across sessions, call `memory_write` with one clear fact now. ' +
      'If you intentionally did not persist it, say so explicitly — do not claim it is stored when it is not.',
  };
}
