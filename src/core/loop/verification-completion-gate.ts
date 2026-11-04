/**
 * Cursor-style "check your own work" completion gate, generalized beyond task
 * contracts: when a run changed files but never inspected or verified the
 * result afterwards, the final answer is held once and the model must either
 * run a real check or state plainly that the change is unverified.
 *
 * Why this exists: the task acceptance gate only covers runs that defined a
 * `task_define` contract. Ordinary "implement X" runs could end with an edit
 * and a success story and nothing else. Cursor's acceptance loop is not a
 * separate mode — the agent runs tests and re-reads its output as part of its
 * normal loop, and the user is told what was and was not verified.
 *
 * Design constraints (same as the acceptance gate):
 * - fires at most once per run (bounded correction, never an infinite loop);
 * - an honest "this is unverified and here is why" answer is allowed through;
 * - a read-only probe after the last edit counts as a check, because a wrong
 *   path or a typo is exactly what reading it back catches;
 * - no task contract is required; plain chat runs are unaffected because they
 *   mutate nothing.
 */
import type { Message } from '../session/session-jsonl.js';
import type { AgentLoopExtensions } from './agent-loop-types.js';

/** Tools that change files: a run that called any of these must verify. */
const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'device_file_write',
]);

/** Read-only checks that count as inspecting the change. */
const CHECK_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'task_acceptance',
  'record_evidence',
  'device_probe',
  'device_file_read',
  'device_file_list',
]);

/** Commands that inspect or verify, not just do more work. */
const CHECK_COMMAND_RE =
  /(^|[\s;&|])(cat|head|tail|less|ls|stat|diff|git\s+(diff|status|show))\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|verify|build)\w*|\b(npx\s+)?(vitest|jest|tsc|eslint|prettier)\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\bmoss\s+(verify|check|bench)\b/;

/** The model admits it did not verify: allowed through (honesty over theatre). */
const UNVERIFIED_DISCLOSURE_RE =
  /(未验证|未运行验证|未做验证|没有验证|无法验证|未能验证|unverified|not\s+verified|did\s+not\s+verify|could\s+not\s+verify|cannot\s+verify)/i;

interface RecordedCall {
  name: string;
  input: Record<string, unknown>;
  resultText: string;
  isError: boolean;
}

function toolResultText(block: { content?: unknown }): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/** Chronological tool calls with their results (paired by tool_use_id). */
function collectCalls(messages: readonly Message[]): RecordedCall[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; tool_use_id?: string; is_error?: boolean };
      if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue;
      results.set(typed.tool_use_id, {
        text: toolResultText(block as { content?: unknown }),
        isError: typed.is_error === true,
      });
    }
  }
  const calls: RecordedCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      if (typed.type !== 'tool_use' || typeof typed.name !== 'string') continue;
      const result = typeof typed.id === 'string' ? results.get(typed.id) : undefined;
      calls.push({
        name: typed.name,
        input:
          typed.input && typeof typed.input === 'object'
            ? (typed.input as Record<string, unknown>)
            : {},
        resultText: result?.text ?? '',
        isError: result?.isError ?? false,
      });
    }
  }
  return calls;
}

function isCheckCall(call: RecordedCall): boolean {
  if (call.isError) return false;
  if (CHECK_TOOLS.has(call.name)) return true;
  if (call.name === 'exec' || call.name === 'shell' || call.name === 'device_exec') {
    const command = call.input.command;
    return typeof command === 'string' && CHECK_COMMAND_RE.test(command);
  }
  return false;
}

export interface VerificationGateDecision {
  ok: boolean;
  reason: string;
  correction?: string;
}

export function evaluateVerificationCompletionGate(request: {
  response: string;
  messages: readonly Message[];
}): VerificationGateDecision {
  const calls = collectCalls(request.messages);
  let lastMutation = -1;
  for (let index = 0; index < calls.length; index += 1) {
    if (MUTATION_TOOLS.has(calls[index]!.name)) lastMutation = index;
  }
  if (lastMutation < 0) return { ok: true, reason: 'no file mutations in this run' };
  const checkedAfter = calls.slice(lastMutation + 1).some(isCheckCall);
  if (checkedAfter) return { ok: true, reason: 'the change was inspected after the last edit' };
  if (UNVERIFIED_DISCLOSURE_RE.test(request.response)) {
    return { ok: true, reason: 'the answer states it is unverified' };
  }
  return {
    ok: false,
    reason: 'files were changed but the result was never checked',
    correction:
      'You changed files but the last thing you did afterwards was answer your own claim. ' +
      'Before finishing, inspect the actual result: read the file back, or run the check that ' +
      'proves it (run_tests / a lint, build or verify command), and report what you observed. ' +
      'If verification is genuinely impossible here, say explicitly that the change is unverified ' +
      'and why — do not present an unchecked change as done.',
  };
}

/**
 * Per-run wrapper: blocks at most once. After one correction the run may end
 * (verified, honestly disclosed, or plainly after not complying) — the gate
 * never rejects the completion, so it cannot deadlock a run.
 */
export function createVerificationCompletionGate(): NonNullable<
  AgentLoopExtensions['completionGate']
> {
  let blocked = false;
  return async (request) => {
    const decision = evaluateVerificationCompletionGate(request);
    if (decision.ok) return { ok: true as const };
    if (blocked) return { ok: true as const };
    blocked = true;
    return {
      ok: false as const,
      reason: decision.reason,
      ...(decision.correction ? { correction: decision.correction } : {}),
      retryLimit: 1,
    };
  };
}
