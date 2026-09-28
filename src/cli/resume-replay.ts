import { toolHeadline } from './tool-headline.js';

/**
 * A stored conversation message, structurally typed so the resume-replay helpers
 * don't need to import the core session schema.
 * @internal
 */
export type ResumableMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
};

/**
 * The human-readable text a user typed or the assistant said — drops tool_use /
 * tool_result blocks and internal goal checkpoints — so a resumed session can be
 * re-displayed as the conversation, not as raw protocol.
 * @internal
 */
export function resumedMessageText(message: ResumableMessage): string {
  const raw =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('\n');
  const text = raw.trim();
  if (!text || text.includes('<moss_working_context_checkpoint')) return '';
  return text;
}

/**
 * One-line summaries of the tool_use blocks in an assistant message, so a
 * resumed session can show WHAT the agent did on each turn (not just the prose)
 * — e.g. `⎿ edit_file (hello.js)`, `⎿ exec (node verify.js)`. Reuses toolHeadline
 * for the input summary. Returns [] for user messages or text-only turns.
 * @internal
 */
export function resumedToolLines(message: ResumableMessage): string[] {
  if (message.role !== 'assistant') return [];
  if (typeof message.content === 'string') return [];
  const lines: string[] = [];
  for (const block of message.content) {
    if (!block || block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const headline = toolHeadline(block.input);
    lines.push(headline ? `⎿ ${name} (${headline})` : `⎿ ${name}`);
  }
  return lines;
}

/** How many recent conversation turns /resume replays into the transcript. @internal */
export const RESUME_REPLAY_MAX = 24;

/**
 * Build the transcript rows that replay a resumed conversation's recent turns, so
 * resuming SHOWS the conversation (like Claude Code / Codex / opencode) instead of
 * a blank screen. Tool/checkpoint-only turns are dropped; returns the visible rows
 * plus how many older conversation turns were elided.
 *
 * Each assistant turn also emits a `system` row per tool_use block (via
 * resumedToolLines) so the user can see the agent's prior actions, not just its
 * prose — previously the replay stripped all tool calls and the user had no idea
 * what the agent had already done after resuming.
 * @internal
 */
export function buildResumeReplay(
  messages: ReadonlyArray<ResumableMessage>,
  max: number = RESUME_REPLAY_MAX
): { items: Array<{ kind: 'user' | 'assistant' | 'system'; text: string }>; hiddenCount: number } {
  const rows: Array<{ kind: 'user' | 'assistant' | 'system'; text: string }> = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = resumedMessageText(message);
    if (text) rows.push({ kind: message.role, text });
    // After an assistant turn's prose, surface the tools it called so the
    // resumed user can see the action history. (Skipped on user turns.)
    if (message.role === 'assistant') {
      for (const toolLine of resumedToolLines(message)) {
        rows.push({ kind: 'system', text: toolLine });
      }
    }
  }
  const hiddenCount = Math.max(0, rows.length - max);
  return { items: hiddenCount > 0 ? rows.slice(rows.length - max) : rows, hiddenCount };
}
