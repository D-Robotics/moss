import type { Tool } from '../core/tools/tool-types.js';

/**
 * todo_write — long-task progress "external brain".
 *
 * Same model, a multi-step refactor loses the thread less when the plan is
 * materialized as a tool result rather than held in the model's short-term
 * memory. The returned checklist is a normal tool_result, so the next turn
 * always sees it — no separate persistence layer needed (the agent loop's
 * message history is the store).
 *
 * Design notes:
 * - stateless on purpose: each call replaces the full list. This avoids a
 *   module-level mutable store (forbidden in library packages) and keeps the
 *   model honest about the whole plan rather than mutating piecemeal.
 * - exactly one todo should be `in_progress` at a time; the renderer
 *   highlights it so the model (and user) can see what's being worked on.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const TODO_STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
};

const TODO_LINE_RE = /^\s*\d+\.\s+[○◐✓]\s+(.+?)\s+\[(pending|in_progress|completed)\]\s*$/gm;

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.';
  const lines = todos.map((t, i) => {
    const glyph = TODO_STATUS_GLYPH[t.status] ?? '○';
    return `${i + 1}. ${glyph} ${t.content} [${t.status}]`;
  });
  const done = todos.filter((t) => t.status === 'completed').length;
  lines.push('', `Progress: ${done}/${todos.length} complete.`);
  return lines.join('\n');
}

/**
 * Parse a todo_write tool_result body back into structured items.
 * Returns null when the text is not a checklist; [] when explicitly cleared.
 * Used by the TUI sticky task panel (Claude Code / Grok Todo parity).
 */
export function parseTodoChecklistText(text: string): TodoItem[] | null {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  if (/Todo list cleared/i.test(body)) return [];
  if (!/Progress:\s*\d+\/\d+\s+complete/i.test(body) && !/\[(pending|in_progress|completed)\]/.test(body)) {
    return null;
  }
  const items: TodoItem[] = [];
  TODO_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TODO_LINE_RE.exec(body)) !== null) {
    const content = (match[1] ?? '').trim();
    const status = match[2] as TodoStatus;
    if (content) items.push({ content, status });
  }
  return items.length > 0 ? items : null;
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Create and manage a structured task list for the current coding session (Claude Code TodoWrite parity). ' +
    'Use proactively for: complex multi-step work (3+ distinct steps), non-trivial features, explicit multi-item user lists, ' +
    'or right after receiving new instructions. Skip for a single trivial step or pure conversation.\n' +
    '- Call at the start with the full plan; mark a step `in_progress` BEFORE starting it (exactly one in_progress).\n' +
    '- After completing a step, mark it `completed` and add any new follow-ups discovered during implementation.\n' +
    '- Each call replaces the whole list — re-send every todo every time.\n' +
    '- The checklist is a normal tool result so the next turn always sees progress on long refactors.',
  metadata: {
    sideEffectClass: 'runtime_state',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Ordered checklist. Each item has content (imperative, ≤120 chars) and status.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs doing, e.g. "Fix login bug in auth.ts"' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending = not started, in_progress = actively working (one at a time), completed = done',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(input) {
    const raw = Array.isArray(input.todos) ? input.todos : [];
    const todos: TodoItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const content = String(item.content ?? '').trim().slice(0, 120);
      if (!content) continue;
      const status: TodoStatus =
        item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending';
      todos.push({ content, status });
    }
    if (todos.length > 50) {
      return 'Error: too many todos (max 50). Split the task or drop completed items from the list.';
    }
    return formatTodos(todos);
  },
};
