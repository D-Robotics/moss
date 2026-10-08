/**
 * Shared low-level helpers for scanning tool_use / tool_result blocks out of
 * a message history. Lives in `context/` (a lower layer than `cli/`) so both
 * the compaction path (`context/compaction.ts`) and the CLI completion gate
 * (`cli/coding-completion-gate.ts`) can reuse them without a context→cli
 * layering inversion. @public
 */
import type { Message } from '../contracts/messages.js';

export interface ParsedTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const TODO_LINE_RE = /^\s*\d+\.\s+[○◐✓]\s+(.+?)\s+\[(pending|in_progress|completed)\]\s*$/gm;

/** Coerce a tool_result block to its flattened text content. */
export function toolResultText(block: unknown): string {
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

/** Map tool_use_id → tool name from assistant tool_use blocks in the session. */
export function toolUseNameById(messages: Message[]): Map<string, string> {
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

/**
 * Find the most recent todo_write checklist in the message history (scanning
 * from the end). Returns the structured items, [] when the list was explicitly
 * cleared, or null when no todo_write result is present. Used by the TUI sticky
 * task panel, the CLI completion gate, and — critically — by compaction to
 * preserve the active checklist across context compression (otherwise a long
 * coding task loses its todo thread when the todo_write result lands in the
 * pruned middle).
 */
export function extractLatestTodosFromMessages(messages: Message[]): ParsedTodoItem[] | null {
  const nameById = toolUseNameById(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j] as {
        type?: string;
        name?: string;
        tool_name?: string;
        toolName?: string;
        tool_use_id?: string;
        toolCallId?: string;
      };
      if (!block || block.type !== 'tool_result') continue;
      const useId = block.tool_use_id ?? block.toolCallId ?? '';
      const name =
        block.name ??
        block.tool_name ??
        block.toolName ??
        (useId ? nameById.get(useId) : undefined) ??
        '';
      const text = toolResultText(block);
      if (!text) continue;
      const looksLikeTodo =
        name === 'todo_write' ||
        (/Progress:\s*\d+\/\d+\s+complete/i.test(text) &&
          /\[(pending|in_progress|completed)\]/.test(text));
      if (!looksLikeTodo) continue;
      if (/Todo list cleared/i.test(text)) return [];
      const items: ParsedTodoItem[] = [];
      TODO_LINE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TODO_LINE_RE.exec(text)) !== null) {
        const content = (match[1] ?? '').trim();
        const status = match[2] as ParsedTodoItem['status'];
        if (content) items.push({ content, status });
      }
      if (items.length > 0) return items;
    }
  }
  return null;
}

const TASK_ANCHOR_MAX_CHARS = 800;

/** Latest task contract and acceptance verdict still in the message history. */
export interface TaskAnchor {
  contract?: string;
  verdict?: string;
}

function clipAnchor(text: string): string {
  const flat = text.replace(/\s+$/g, '').trim();
  if (flat.length <= TASK_ANCHOR_MAX_CHARS) return flat;
  return `${flat.slice(0, TASK_ANCHOR_MAX_CHARS)}…`;
}

/**
 * The newest `task_define` result and the newest `task_acceptance` result.
 * Compaction otherwise drops both when they sit in the pruned middle, and a
 * long task continues without its contract or its last FAIL/PASS.
 */
export function extractTaskAnchorFromMessages(messages: Message[]): TaskAnchor | null {
  const nameById = toolUseNameById(messages);
  let contract: string | undefined;
  let verdict: string | undefined;
  for (let i = messages.length - 1; i >= 0 && (!contract || !verdict); i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0 && (!contract || !verdict); j -= 1) {
      const block = message.content[j] as {
        type?: string;
        name?: string;
        tool_name?: string;
        toolName?: string;
        tool_use_id?: string;
        toolCallId?: string;
      };
      if (!block || block.type !== 'tool_result') continue;
      const useId = block.tool_use_id ?? block.toolCallId ?? '';
      const name =
        block.name ??
        block.tool_name ??
        block.toolName ??
        (useId ? nameById.get(useId) : undefined) ??
        '';
      const text = toolResultText(block);
      if (!text.trim()) continue;
      if (!verdict && name === 'task_acceptance') verdict = clipAnchor(text);
      else if (!contract && name === 'task_define') contract = clipAnchor(text);
    }
  }
  if (!contract && !verdict) return null;
  return {
    ...(contract ? { contract } : {}),
    ...(verdict ? { verdict } : {}),
  };
}
