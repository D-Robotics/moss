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
 * Task OS M12 finding #3: a live unified task already owns the checklist, so a
 * parallel todo list just costs turns (2-3 per run). Only a task that actually
 * has a plan suppresses the tool — a stale draft with an empty plan must not
 * silently disable todos, because ambient workspace state is not a contract.
 */
async function liveTaskPlanNotice(workspaceDir: string | undefined): Promise<string | null> {
  if (!workspaceDir) return null;
  try {
    const { findLatestLiveTaskSnapshot } = await import('../core/task/task-store.js');
    const snapshot = await findLatestLiveTaskSnapshot(workspaceDir);
    if (!snapshot || snapshot.plan.length === 0) return null;
    const plan = snapshot.plan
      .map((step) => {
        const marker =
          step.status === 'done' ? '[x]' : step.status === 'in_progress' ? '[>]' : '[ ]';
        return `${marker} ${step.title}`;
      })
      .join('\n');
    return (
      `Not applied — the live task ${snapshot.taskId} already owns the checklist ` +
      `(phase ${snapshot.phase}). Maintain that plan with task_plan_update so the ` +
      `timeline, acceptance and TUI stay in sync instead of forking a second list.\n` +
      `Current plan:\n${plan}`
    );
  } catch {
    return null;
  }
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Replace the session checklist. Use for 3+ steps; skip a single trivial step. Exactly one item is in_progress. Each call sends the full list.',
  metadata: {
    sideEffectClass: 'runtime_state',
    planMode: 'allow',
    retainResult: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description:
          'Ordered checklist. Each item has content (imperative, ≤120 chars) and status.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'What needs doing, e.g. "Fix login bug in auth.ts"',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description:
                'pending = not started, in_progress = actively working (one at a time), completed = done',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(input, ctx) {
    const owned = await liveTaskPlanNotice(ctx?.workspaceDir);
    if (owned) return owned;
    const raw = Array.isArray(input.todos) ? input.todos : [];
    const todos: TodoItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const content = String(item.content ?? '')
        .trim()
        .slice(0, 120);
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
