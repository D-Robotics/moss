import { resumeUserText } from '../core/session/internal-transcript.js';
import { toolLabel } from './tui/transcript.js';

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
  return resumeUserText(raw);
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
    const input =
      block.input && typeof block.input === 'object'
        ? (block.input as Record<string, unknown>)
        : {};
    // B232: replay uses the same labels as the live transcript
    // (`Read(a.txt)`, `Run Tests(running tests)`), not raw snake_case tool names.
    lines.push(`⎿ ${toolLabel(name, input)}`);
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
  // B231/B232: tool-only turns chain into long `⎿` runs (a debugging turn can
  // call 20+ tools across several assistant messages). Collapse each run of
  // more than three consecutive tool rows into one grouped line.
  const compacted: typeof rows = [];
  for (let index = 0; index < rows.length; ) {
    const row = rows[index];
    if (!(row.kind === 'system' && row.text.startsWith('⎿ '))) {
      compacted.push(row);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length) {
      const candidate = rows[end];
      if (!(candidate.kind === 'system' && candidate.text.startsWith('⎿ '))) break;
      end += 1;
    }
    const run = rows.slice(index, end);
    if (run.length <= 3) {
      compacted.push(...run);
    } else {
      const order: string[] = [];
      const counts = new Map<string, number>();
      for (const toolRow of run) {
        const name = /^⎿ (.+?)(?:\(|$)/.exec(toolRow.text)?.[1] ?? 'tool';
        if (!counts.has(name)) order.push(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const shown = order.slice(0, 4).map((name) => {
        const count = counts.get(name) ?? 1;
        return count > 1 ? `${name} ×${count}` : name;
      });
      const more = order.length > shown.length ? ` · +${order.length - shown.length} more` : '';
      compacted.push({
        kind: 'system',
        text: `⎿ ${run.length} tool calls: ${shown.join(' · ')}${more}`,
      });
    }
    index = end;
  }
  const hiddenCount = Math.max(0, compacted.length - max);
  return {
    items: hiddenCount > 0 ? compacted.slice(compacted.length - max) : compacted,
    hiddenCount,
  };
}
