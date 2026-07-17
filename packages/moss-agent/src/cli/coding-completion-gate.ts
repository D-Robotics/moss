/**
 * Coding verification + incomplete-todo completion gate (CLI host).
 *
 * 1) When the model edits code and reports done without running any verification
 *    (run_tests / verify_fix / exec of a test/build command), inject one
 *    correction turn — Claude Code / Codex discipline.
 * 2) When the model opened a multi-item todo_write checklist and still has
 *    pending / in_progress items, inject one correction — Grok TodoGate light
 *    (enabled by default, max 1 fire via retryLimit).
 *
 * Soft: only one retry each, only on clear multi-step / coding-change intents.
 */
import type { Message } from '../core/session/session-jsonl.js';

export interface CodingCompletionGateRequest {
  sessionKey: string;
  runId: string;
  turn: number;
  response: string;
  stopReason?: string;
  messages: Message[];
  totalToolCalls: number;
  toolCallsByName: Record<string, number>;
}

export type CodingCompletionGateResult =
  | { ok: true }
  | { ok: false; reason: string; correction?: string; retryLimit?: number };

const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'apply_patch']);
const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

const CODING_CHANGE_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|add\s+(?:a\s+)?(?:test|feature)|repair|patch|修改|修复|实现|重构|优化|加(?:一个|个)?测试|写测试)/iu;

const TODO_LINE_RE = /^\s*\d+\.\s+[○◐✓]\s+(.+?)\s+\[(pending|in_progress|completed)\]\s*$/gm;

export interface ParsedTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      // Skip system correction messages
      if (m.content.startsWith('[System]')) continue;
      return m.content;
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (text.startsWith('[System]')) continue;
      // tool_result-only user messages are not the original request
      if (!text.trim()) continue;
      return text;
    }
  }
  return '';
}

function countByPrefix(byName: Record<string, number>, names: Set<string>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (names.has(name)) n += count;
  }
  return n;
}

function toolResultText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: string; content?: unknown; text?: string; name?: string; tool_name?: string };
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

/**
 * Parse the latest todo_write tool_result checklist from session messages.
 * Returns null when no checklist was established.
 * @internal exported for unit tests
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
        block.name ?? block.tool_name ?? block.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      const text = toolResultText(block);
      if (!text) continue;
      // tool_result blocks usually only carry tool_use_id; resolve name via
      // the matching assistant tool_use, or sniff the checklist shape.
      const looksLikeTodo =
        name === 'todo_write' ||
        (/Progress:\s*\d+\/\d+\s+complete/i.test(text) && /\[(pending|in_progress|completed)\]/.test(text));
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

/**
 * Soft gate: multi-item todo checklist still has open work.
 * Grok TodoGate parity (light): one correction, only when the model already
 * committed to a plan via todo_write with 2+ items.
 */
export function evaluateTodoCompletionGate(
  request: CodingCompletionGateRequest
): CodingCompletionGateResult {
  const todoCalls = request.toolCallsByName.todo_write ?? 0;
  if (todoCalls === 0) return { ok: true };

  const todos = extractLatestTodosFromMessages(request.messages);
  if (!todos || todos.length < 2) return { ok: true };

  const open = todos.filter((t) => t.status !== 'completed');
  if (open.length === 0) return { ok: true };

  // Model already said work remains / listed next steps — don't thrash.
  if (
    /\b(?:remaining|still (?:need|to do|working)|next steps?|not (?:yet )?done|WIP|in progress)\b|未完成|还剩|下一步/iu.test(
      request.response
    )
  ) {
    return { ok: true };
  }

  const preview = open
    .slice(0, 5)
    .map((t) => `- [${t.status}] ${t.content}`)
    .join('\n');
  const more = open.length > 5 ? `\n- …and ${open.length - 5} more` : '';

  return {
    ok: false,
    reason: 'incomplete todos',
    retryLimit: 1,
    correction:
      `[System] Your todo list still has ${open.length} open item(s) — do not report done yet:\n` +
      `${preview}${more}\n` +
      'Finish the remaining work (or revise the list with todo_write if scope changed), ' +
      'mark items completed as you go, then report done only when the checklist is clear or you have ' +
      'explicitly cancelled abandoned items.',
  };
}

/**
 * Soft gate: if the run edited files under a coding-change intent and never
 * called a verification tool, reject once with a correction that forces
 * run_tests / verify_fix / the project's test command.
 */
export function evaluateCodingCompletionGate(
  request: CodingCompletionGateRequest
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  const verifies = countByPrefix(request.toolCallsByName, VERIFY_TOOLS);
  // exec often runs tests; treat any exec after edits as weak evidence of verification.
  // Still prefer run_tests when available, but don't force a second loop if exec was used.
  const execs = request.toolCallsByName.exec ?? 0;
  if (verifies > 0 || execs > 0) return { ok: true };

  const userText = lastUserText(request.messages);
  if (!userText || !CODING_CHANGE_RE.test(userText)) return { ok: true };

  // Doc-only / config-only edits often use write_file without tests — if the
  // response already admits no tests were run, don't nag.
  if (/\b(?:did not|didn't|no)\s+(?:run\s+)?tests?\b|未运行测试|没有跑测试/iu.test(request.response)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'edited code without verification',
    retryLimit: 1,
    correction:
      '[System] You edited code but did not run verification. Before finishing: ' +
      'call `run_tests` (or `verify_fix`, or `exec` with the project test/build command), ' +
      'see the real output, then report done with that evidence. Do not claim the change works without running it.',
  };
}

/**
 * Compose host completion gates: structured-output is handled inside MossAgent
 * before this runs. Chain coding verification + todo gate with any additional host gate.
 */
export function createCliCompletionGate(
  extra?: (request: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> | CodingCompletionGateResult
): (request: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> {
  return async (request) => {
    // Todo incomplete first: multi-step plans must not be abandoned mid-list
    // even when verification already ran on a partial step.
    const todos = evaluateTodoCompletionGate(request);
    if (!todos.ok) return todos;
    const coding = evaluateCodingCompletionGate(request);
    if (!coding.ok) return coding;
    if (extra) return extra(request);
    return { ok: true };
  };
}
