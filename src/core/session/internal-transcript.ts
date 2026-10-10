/**
 * Text the model sees that is not something the user said: task-phase prompts,
 * `[System]` nudges, and working-context checkpoints. Surfaces that title a
 * session or replay a transcript skip these so internal mechanics stay off
 * the screen.
 */

const PHASE_MARK = '[task-phase:';

export function isInternalUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[System]')) return true;
  if (trimmed.startsWith(PHASE_MARK)) return true;
  if (trimmed.includes('<moss_working_context_checkpoint')) return true;
  return false;
}

/** Goal line from a task-phase prompt, when that prompt carries one. */
export function goalFromPhasePrompt(text: string): string | undefined {
  if (!text.includes(PHASE_MARK)) return undefined;
  const match = /^Goal:\s*(.+)$/m.exec(text);
  const goal = match?.[1]?.trim();
  return goal || undefined;
}

/**
 * Newest real user request for nudge matching. Phase prompts and system
 * injections are not the user's intent (a planning prompt that mentions
 * `npm test` must not look like "the user asked to run tests").
 */
export function selectNudgeUserText(candidatesNewestFirst: readonly string[]): string {
  for (const text of candidatesNewestFirst) {
    if (!text.trim()) continue;
    if (isInternalUserText(text)) continue;
    return text;
  }
  return '';
}

/**
 * Drop a `<turn-context>` block (and a title clipped inside an unclosed one)
 * so session previews show the user's words, not the environment preamble.
 */
export function userTextWithoutTurnContext(text: string): string {
  const closed = text.replace(/<turn-context>[\s\S]*?<\/turn-context>/g, ' ');
  const open = closed.indexOf('<turn-context>');
  const cut = open === -1 ? closed : closed.slice(0, open);
  return cut.replace(/\s+/g, ' ').trim();
}

/** Session list title: the user's goal, never the engine's phase prompt. */
export function sessionTitleFromTexts(texts: readonly string[]): string | undefined {
  const clip = (value: string): string => {
    const cleaned = userTextWithoutTurnContext(value);
    if (!cleaned) return '';
    return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
  };
  for (const text of texts) {
    const goal = goalFromPhasePrompt(text);
    if (goal) {
      const titled = clip(goal);
      if (titled) return titled;
    }
    if (isInternalUserText(text)) continue;
    const titled = clip(text);
    if (titled) return titled;
  }
  return undefined;
}

/**
 * User row for `/resume`. Planning prompts collapse to the goal line; later
 * phase prompts and system nudges are dropped.
 */
export function resumeUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('<moss_working_context_checkpoint')) return '';
  if (trimmed.startsWith('[System]')) return '';
  if (trimmed.startsWith('[task-phase:planning]')) return goalFromPhasePrompt(text) ?? '';
  if (trimmed.startsWith(PHASE_MARK)) return '';
  if (isInternalAssistantText(trimmed)) return '';
  return trimmed;
}

/** Assistant text that is an injected nudge, not an answer. */
export function isInternalAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[System]')) return true;
  if (trimmed.startsWith('[task-phase:')) return true;
  if (trimmed.includes('检测到仅说明了工具与链接')) return true;
  return false;
}
