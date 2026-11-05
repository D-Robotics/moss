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
 * One checklist, not two.
 *
 * Task OS M12 finding #3: a live task already owns the checklist, so a parallel
 * todo list costs 2-3 turns per run. The old behavior refused the write and told
 * the model to call `task_plan_update` instead — honest, but still two surfaces
 * and two vocabularies for the same plan. Now `todo_write` *is* the plan write:
 * when a live task exists the list is mapped onto its plan steps and appended as
 * a `plan_step_updated` event, so the timeline, acceptance view and TUI see the
 * same checklist the model just wrote. Nothing is persisted for a session todo,
 * so there is no second copy to drift.
 *
 * A terminal task is left alone (plans are frozen on settled tasks); the session
 * list is then only a display convenience.
 */
async function applyTodoToLiveTask(
  workspaceDir: string | undefined,
  todos: readonly TodoItem[]
): Promise<string | null> {
  if (!workspaceDir || todos.length === 0) return null;
  try {
    const { findLatestLiveTaskSnapshot, tryAppendTaskEvent } =
      await import('../core/task/task-store.js');
    const snapshot = await findLatestLiveTaskSnapshot(workspaceDir);
    if (!snapshot) return null;
    const statusMap: Record<TodoStatus, 'pending' | 'in_progress' | 'done'> = {
      pending: 'pending',
      in_progress: 'in_progress',
      completed: 'done',
    };
    const steps = todos.map((todo, index) => ({
      stepId: `todo_${index + 1}`,
      title: todo.content,
      status: statusMap[todo.status],
    }));
    await tryAppendTaskEvent(workspaceDir, snapshot.taskId, 'plan_step_updated', { steps });
    const marks = steps
      .map(
        (step) =>
          `  [${step.status === 'done' ? 'x]' : step.status === 'in_progress' ? '>]' : ' ]'} ${step.title}`
      )
      .join('\n');
    return (
      `Applied to the live task ${snapshot.taskId} plan (phase ${snapshot.phase}) — one checklist, ` +
      `not a second one. The timeline and acceptance view now show these steps.\n${marks}`
    );
  } catch {
    return null;
  }
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Replace the checklist. Use for 3+ steps; skip a single trivial step. Exactly one item is in_progress. Each call sends the full list. When a live task exists this writes its plan steps (same list, one source of truth). Not for recording acceptance or evidence — that is record_evidence/task_acceptance.',
  metadata: {
    leanDescription:
      'Replace the checklist for 3+ steps; one in_progress. Not for a single trivial action.',
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
    const raw = Array.isArray(input.todos) ? input.todos : [];
    const todos: TodoItem[] = [];
    const unknownStatuses: string[] = [];
    // A dropped item used to be invisible: sending one content-less item
    // answered "Todo list cleared.", which reads as an intentional clear.
    const badItems: string[] = [];
    let index = 0;
    for (const item of raw) {
      index += 1;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        badItems.push(`#${String(index)} (not an object)`);
        continue;
      }
      const content = String(item.content ?? '')
        .trim()
        .slice(0, 120);
      if (!content) {
        badItems.push(`#${String(index)} (empty content)`);
        continue;
      }
      // Nested item fields never reach `validateToolInputObject` (it checks the
      // top level only), so `status: "doing"` used to land as `pending` and the
      // model read the write as applied. A list that was not written verbatim
      // must say so.
      const status = item.status;
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        unknownStatuses.push(
          `"${String(content)}" (${status === undefined ? 'missing' : JSON.stringify(status)})`
        );
        continue;
      }
      todos.push({ content, status });
    }
    if (badItems.length > 0) {
      return (
        'Error: todo_write was not applied — every item needs non-empty content and a status. ' +
        `Bad item(s): ${badItems.slice(0, 5).join(', ')}` +
        `${badItems.length > 5 ? ` and ${String(badItems.length - 5)} more` : ''}. ` +
        'Resend the full list; send todos: [] only to clear it.'
      );
    }
    if (unknownStatuses.length > 0) {
      return (
        'Error: todo_write was not applied — every item needs status pending, in_progress ' +
        `or completed. Bad status on: ${unknownStatuses.slice(0, 5).join(', ')}` +
        `${unknownStatuses.length > 5 ? ` and ${String(unknownStatuses.length - 5)} more` : ''}. ` +
        'Resend the full list with a valid status on every item.'
      );
    }
    if (todos.length > 50) {
      return 'Error: too many todos (max 50). Split the task or drop completed items from the list.';
    }
    // A live task owns the checklist: write through instead of forking a list.
    const applied = await applyTodoToLiveTask(ctx?.workspaceDir, todos);
    if (applied) return applied;
    return formatTodos(todos);
  },
};
