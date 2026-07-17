/**
 * Coding verification + incomplete-todo completion gate (CLI host).
 *
 * Chain (first failure wins):
 * 1) Incomplete multi-item todo_write checklist (Grok TodoGate light, retryLimit 2)
 * 2) Edited code under fix/implement intent without fresh green verification after last edit
 * 3) Verification-shaped background command still running while finishing
 * 4) Latest verification result is red while finishing / claiming success
 * 5) Recent tool failure ignored under a done/success claim
 * 6) Fan-out/create_subagent with FAILED children while claiming overall done
 * 7) Fix/bug intent with edits but zero investigation tools (debug soft nudge)
 *
 * Soft: low retryLimit, clear coding / multi-step intents only.
 */
import type { Message } from '../core/session/session-jsonl.js';
import { listBackgroundProcessSnapshots } from '../tools/background-exec.js';

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

const EDIT_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'write_file',
  'apply_patch',
  // Renames change the workspace layout; treat as code mutation for verify gates.
  'move_file',
]);
const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);
const EXEC_TOOLS = new Set(['exec', 'exec_background']);
/** Investigation tools — if none fired before a fix/bug edit, debug soft-nudge. */
const INVESTIGATE_TOOLS = new Set([
  'read_file',
  'search_code',
  'search_files',
  'list_directory',
  'exec',
  'exec_background',
  'run_tests',
  'verify_fix',
  'code_diagnostics',
  'web_search',
  'web_fetch',
]);

const CODING_CHANGE_RE =
  /(?:fix|bug|implement|refactor|optimi[sz]e|add\s+(?:a\s+)?(?:test|feature)|repair|patch|修改|修复|实现|重构|优化|加(?:一个|个)?测试|写测试)/iu;

/** Narrower than CODING_CHANGE_RE: only debug/fix-style intents for blind-edit nudge. */
const DEBUG_FIX_INTENT_RE =
  /(?:fix|bug|repair|patch|报错|失败|崩溃|exception|stack\s*trace|error|错误|修复|修一下)/iu;

/**
 * Implement/refactor intents that still require locate-before-patch discipline
 * (engineering-partner loop: understand before mutate). Narrower than full
 * CODING_CHANGE_RE so pure "add a comment" style asks do not thrash.
 */
const IMPLEMENT_LOCATE_INTENT_RE =
  /(?:implement|refactor|optimi[sz]e|migrate|rewrite|add\s+(?:a\s+)?(?:feature|module|endpoint|api)|实现|重构|优化|迁移|重写|加(?:一个|个)?功能)/iu;

const SKIP_TESTS_USER_RE =
  /(?:不要跑测试|跳过测试|skip\s+tests?|no\s+tests?|only\s+(?:docs?|copy|文案)|只改文案|docs?\s+only|documentation\s+only)/iu;

const TODO_LINE_RE = /^\s*\d+\.\s+[○◐✓]\s+(.+?)\s+\[(pending|in_progress|completed)\]\s*$/gm;

/** Command strings that count as verification when run via exec (any verify class). */
const VERIFY_COMMAND_RE =
  /(?:\b(?:test|tests|verify|typecheck|lint|build|jest|vitest|pytest|mocha)\b|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npm\s+run\s+(?:test|verify|check|lint|build|typecheck)|pnpm\s+run\s+(?:test|verify|check|lint|build|typecheck)|yarn\s+(?:test|run\s+(?:test|verify|check|lint|build|typecheck))|\bnpx\s+tsc\b|\btsc\b)/i;

/**
 * Subset of VERIFY_COMMAND_RE that counts as *runtime suite* evidence for
 * fix/implement intents. Excludes lint/typecheck/build-only commands so
 * `exec tsc` cannot unlock "bug is fixed" without running tests.
 */
/**
 * Runtime suite evidence only. Note: bare `npm run check` is *not* included —
 * monorepos often map `check` to lint+typecheck without tests. Prefer test/verify
 * scripts, or tools named *test*.
 */
const RUNTIME_TEST_COMMAND_RE =
  /(?:\b(?:test|tests|jest|vitest|pytest|mocha)\b|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npm\s+run\s+(?:test|verify)\b|pnpm\s+run\s+(?:test|verify)\b|yarn\s+(?:test|run\s+(?:test|verify))\b)/i;

const SUCCESS_CLAIM_RE =
  /(?:all\s+)?(?:tests?\s+)?pass(?:ed|ing)?|全部通过|验证通过|已修复|bug is fixed|works now|\ball green\b|all done|全部完成/iu;

const ADMITS_FAILURE_RE =
  /\b(?:fail(?:ed|ing|ure)?|error|red|broken|still\s+failing|not\s+pass(?:ing)?)\b|失败|报错|未通过|仍有错误|还在失败/iu;

const TOOL_FAILURE_TEXT_RE =
  /^(?:Error:|✗)|exit code [1-9]\d*|\b(?:ENOENT|EACCES|TypeError|ReferenceError|SyntaxError)\b|old_string not found|❌\s*\d+\s+FAILED|❌\s+ISSUES FOUND|❌\s+FAIL\b/im;

const VERIFY_RESULT_FAIL_RE =
  /❌\s*\d+\s+FAILED|❌\s+ISSUES FOUND|❌\s+FAIL\b|Verify Fix:\s*❌|Build:\s*❌\s*FAIL|Typecheck:\s*❌\s*FAIL|Tests:\s*❌\s*FAIL|testsOk:\s*false|failed:\s*[1-9]\d*/i;

export interface ParsedTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      if (m.content.startsWith('[System]')) continue;
      return m.content;
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (text.startsWith('[System]')) continue;
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

function toolUseCommand(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'input'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
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

/** tool_use_id → command string for exec / exec_background. */
function execCommandByUseId(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
      if (!b.name || !EXEC_TOOLS.has(b.name)) continue;
      const cmd = toolUseCommand(b.input);
      if (cmd) map.set(b.id, cmd);
    }
  }
  return map;
}

function isVerificationCommand(command: string): boolean {
  return Boolean(command.trim() && VERIFY_COMMAND_RE.test(command));
}

function isRuntimeTestCommand(command: string): boolean {
  return Boolean(command.trim() && RUNTIME_TEST_COMMAND_RE.test(command));
}

/**
 * True when the session ever invoked a verify-class tool / verify-shaped exec.
 * Sticky (does not require post-edit freshness). Prefer
 * `hasFreshGreenVerificationAfterLastEdit` for completion honesty.
 */
export function hasVerificationEvidence(
  messages: Message[],
  toolCallsByName: Record<string, number>,
): boolean {
  if (countByPrefix(toolCallsByName, VERIFY_TOOLS) > 0) return true;

  const execById = execCommandByUseId(messages);
  for (const cmd of execById.values()) {
    if (isVerificationCommand(cmd)) return true;
  }

  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name) continue;
      if (VERIFY_TOOLS.has(b.name)) return true;
      if (EXEC_TOOLS.has(b.name) && isVerificationCommand(toolUseCommand(b.input))) return true;
    }
  }
  return false;
}

/**
 * Ordered post-condition: a green verification *result* must appear after the
 * last code-mutation tool_use. Stale greens (verify then more edits) do not count.
 * Bare tool_use / still-running bg start without a terminal result does not count.
 *
 * @param options.requireRuntimeTests When true (fix/implement intents), a green
 *   code_diagnostics-only result is not enough — need run_tests / verify_fix
 *   or a verification-shaped exec after the last edit.
 */
export function hasFreshGreenVerificationAfterLastEdit(
  messages: Message[],
  options?: { requireRuntimeTests?: boolean },
): boolean {
  const nameById = toolUseNameById(messages);
  const execById = execCommandByUseId(messages);
  const requireRuntime = options?.requireRuntimeTests === true;

  let lastEditSeq = -1;
  let lastGreenVerifySeq = -1;
  let lastGreenWasDiagnosticsOnly = false;
  let seq = 0;

  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      seq += 1;
      const b = block as {
        type?: string;
        name?: string;
        id?: string;
        input?: unknown;
        tool_use_id?: string;
        toolCallId?: string;
        tool_name?: string;
        toolName?: string;
        outcome?: string;
        is_error?: boolean;
        isError?: boolean;
      };

      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        if (EDIT_TOOLS.has(b.name)) {
          lastEditSeq = seq;
        }
        continue;
      }

      if (b?.type !== 'tool_result') continue;
      const useId = b.tool_use_id ?? b.toolCallId ?? '';
      const name =
        b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      let isVerification = VERIFY_TOOLS.has(name);
      if (!isVerification && EXEC_TOOLS.has(name)) {
        const cmd = useId ? execById.get(useId) : undefined;
        isVerification = Boolean(cmd && isVerificationCommand(cmd));
      }
      if (!isVerification) continue;

      const text = toolResultText(b);
      const flaggedError =
        b.is_error === true ||
        b.isError === true ||
        b.outcome === 'error' ||
        b.outcome === 'blocked' ||
        b.outcome === 'denied';
      // Still-running background starts are not terminal green evidence.
      if (/Still running|Started bg_/i.test(text) && !/exited|exit \d+/i.test(text)) {
        continue;
      }
      if (isVerificationResultFailure(text, flaggedError)) {
        continue;
      }
      // Empty suite / no steps / no tests executed is not green evidence.
      if (
        /NO TESTS EXECUTED|NO STEPS EXECUTED|Tests:\s*0\s+total,\s*0\s+passed|Verify Fix:\s*⚠️/i.test(
          text,
        )
      ) {
        continue;
      }
      // Empty body is not green evidence.
      if (!text.trim() && !flaggedError) continue;

      // Classify whether this green counts as *runtime* suite evidence.
      // - run_tests green → runtime
      // - verify_fix with Tests: skipped only (typecheck/build only) → NOT runtime
      // - code_diagnostics → NOT runtime
      // - exec: only test/suite-shaped commands (not bare tsc/lint/build)
      let countsAsRuntime = false;
      if (name === 'run_tests') {
        countsAsRuntime = true;
      } else if (name === 'verify_fix') {
        const testsSkippedOnly =
          /Tests:\s*⏭\s*skipped/i.test(text) ||
          (/Tests:\s*⏭/i.test(text) && !/Tests:\s*✅\s*pass/i.test(text));
        countsAsRuntime = !testsSkippedOnly;
      } else if (name === 'code_diagnostics') {
        countsAsRuntime = false;
      } else if (EXEC_TOOLS.has(name)) {
        const cmd = useId ? execById.get(useId) : undefined;
        countsAsRuntime = Boolean(cmd && isRuntimeTestCommand(cmd));
      }

      lastGreenVerifySeq = seq;
      lastGreenWasDiagnosticsOnly = !countsAsRuntime;
    }
  }

  // No edits → not the job of this helper (caller short-circuits).
  if (lastEditSeq < 0) return false;
  if (!(lastGreenVerifySeq > lastEditSeq)) return false;
  if (requireRuntime && lastGreenWasDiagnosticsOnly) return false;
  return true;
}

interface NamedToolResult {
  name: string;
  text: string;
  isVerification: boolean;
  /** Explicit tool failure flags from the agent loop (is_error / outcome). */
  isError: boolean;
  outcome?: string;
  /** Suite/runtime evidence (not lint-only diagnostics or bare tsc). */
  isRuntime?: boolean;
}

function classifyRuntimeVerification(name: string, text: string, command?: string): boolean {
  if (name === 'run_tests') return true;
  if (name === 'verify_fix') {
    const testsSkippedOnly =
      /Tests:\s*⏭\s*skipped/i.test(text) ||
      (/Tests:\s*⏭/i.test(text) && !/Tests:\s*✅\s*pass/i.test(text));
    return !testsSkippedOnly;
  }
  if (name === 'code_diagnostics') return false;
  if (EXEC_TOOLS.has(name)) {
    return Boolean(command && isRuntimeTestCommand(command));
  }
  return false;
}

function collectNamedToolResults(messages: Message[]): NamedToolResult[] {
  const nameById = toolUseNameById(messages);
  const execById = execCommandByUseId(messages);
  const out: NamedToolResult[] = [];

  for (const m of messages) {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as {
        type?: string;
        name?: string;
        tool_name?: string;
        toolName?: string;
        tool_use_id?: string;
        toolCallId?: string;
        outcome?: string;
        is_error?: boolean;
        isError?: boolean;
      };
      if (!b || b.type !== 'tool_result') continue;
      const useId = b.tool_use_id ?? b.toolCallId ?? '';
      const name =
        b.name ?? b.tool_name ?? b.toolName ?? (useId ? nameById.get(useId) : undefined) ?? '';
      const text = toolResultText(b);
      const flaggedError =
        b.is_error === true ||
        b.isError === true ||
        b.outcome === 'error' ||
        b.outcome === 'blocked' ||
        b.outcome === 'denied';
      if (!text && !flaggedError) continue;

      const cmd = useId ? execById.get(useId) : undefined;
      let isVerification = VERIFY_TOOLS.has(name);
      if (!isVerification && EXEC_TOOLS.has(name)) {
        isVerification = Boolean(cmd && isVerificationCommand(cmd));
      }

      const body = text || (flaggedError ? `Error: tool ${b.outcome || 'error'}` : '');
      out.push({
        name: name || 'unknown',
        text: body,
        isVerification,
        isError: flaggedError,
        outcome: b.outcome,
        isRuntime: isVerification
          ? classifyRuntimeVerification(name || 'unknown', body, cmd)
          : false,
      });
    }
  }
  return out;
}

/** Prefer latest runtime suite result for red-outcome tracking (parity with RedVerifyNudge). */
function pickLatestRuntimeVerification(results: NamedToolResult[]): NamedToolResult | null {
  const verify = results.filter((r) => r.isVerification);
  if (verify.length === 0) return null;
  for (let i = verify.length - 1; i >= 0; i--) {
    if (verify[i]!.isRuntime) return verify[i]!;
  }
  // No runtime result — fall back to latest verification (diagnostics-only).
  return verify[verify.length - 1]!;
}

function isVerificationResultFailure(text: string, isErrorFlag?: boolean): boolean {
  // Explicit tool failure flags count even without harness FAIL markers
  // (e.g. is_error exec of npm test with plain "Tests failed" body).
  if (isErrorFlag) return true;
  if (!text.trim()) return false;
  if (VERIFY_RESULT_FAIL_RE.test(text)) return true;
  // Explicit all-pass markers win over weak heuristics
  if (/✅\s*ALL PASSED|Verify Fix:\s*✅/i.test(text) && !/❌/.test(text)) return false;
  return false;
}

function isGenericToolFailure(
  text: string,
  outcome?: string,
  isErrorFlag?: boolean,
): boolean {
  // Prefer explicit loop flags — content may not start with "Error:" (e.g. denied).
  if (isErrorFlag) return true;
  if (outcome === 'blocked' || outcome === 'denied' || outcome === 'error') return true;
  if (!text.trim()) return false;
  if (isVerificationResultFailure(text)) return true;
  return TOOL_FAILURE_TEXT_RE.test(text);
}

function failurePreview(text: string, maxLines = 3): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, maxLines)
    .join('\n');
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
 * Grok TodoGate parity (light): up to two corrections.
 */
export function evaluateTodoCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const todoCalls = request.toolCallsByName.todo_write ?? 0;
  if (todoCalls === 0) return { ok: true };

  const todos = extractLatestTodosFromMessages(request.messages);
  if (!todos || todos.length < 2) return { ok: true };

  const open = todos.filter((t) => t.status !== 'completed');
  if (open.length === 0) return { ok: true };

  if (
    /\b(?:remaining|still (?:need|to do|working)|next steps?|not (?:yet )?done|WIP|in progress)\b|未完成|还剩|下一步/iu.test(
      request.response,
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
    retryLimit: 2,
    correction:
      `[System] Your todo list still has ${open.length} open item(s) — do not report done yet:\n` +
      `${preview}${more}\n` +
      'Finish the remaining work (or revise the list with todo_write if scope changed — cancel abandoned items explicitly), ' +
      'mark items completed as you go, then report done only when the checklist is clear.',
  };
}

/**
 * Soft gate: do not finish while a verification-shaped background command is
 * still running (e.g. exec_background npm test). Wait for exit + green evidence.
 */
export function evaluateRunningBackgroundVerifyGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  const userText = lastUserText(request.messages);
  if (userText && SKIP_TESTS_USER_RE.test(userText)) return { ok: true };

  // Only relevant when the model is finishing / claiming success.
  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定|已修复)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  let running: Array<{ id: string; command: string }> = [];
  try {
    running = listBackgroundProcessSnapshots()
      .filter((p) => p.status === 'running')
      .filter((p) => isVerificationCommand(p.command))
      .map((p) => ({ id: p.id, command: p.command }));
  } catch {
    return { ok: true };
  }
  if (running.length === 0) return { ok: true };

  const preview = running
    .slice(0, 3)
    .map((p) => `- ${p.id}: ${p.command.slice(0, 120)}`)
    .join('\n');

  return {
    ok: false,
    reason: 'verification still running in background',
    retryLimit: 1,
    correction:
      '[System] A verification-shaped background command is still running. Do not report done yet.\n' +
      `${preview}\n` +
      'Wait for it to finish (you will get a background-completion notice), read the exit code/output, ' +
      'then re-run or report honestly. Claiming success while tests/build still run is not allowed.',
  };
}

const SUBAGENT_DELEGATION_TOOLS = new Set([
  'fan_out_subagents',
  'create_subagent',
  // Background child completion is observed via status — treat as delegation evidence.
  'subagent_status',
]);

/** Green suite markers that may appear in child summaries (not parent tool_use). */
const DELEGATED_RUNTIME_GREEN_RE =
  /Test Results:\s*✅\s*ALL PASSED|Verify Fix:\s*✅\s*ALL PASSED|Tests:\s*✅\s*pass|ℹ\s*pass\s+[1-9]\d*|exit_code:\s*0[\s\S]{0,80}\b(?:test|tests|pass)/i;

const SUBAGENT_AGGREGATION_RESULT_NAMES = new Set([
  'fan_out_subagents',
  'create_subagent',
  'subagent_status',
]);

/**
 * True when the parent delegated fix/implement work via subagents and is finishing
 * without parent-level runtime verification and without green suite text in child summaries.
 */
export function hasUnverifiedDelegatedMutation(
  messages: Message[],
  toolCallsByName: Record<string, number>,
  userText: string,
  response: string,
): boolean {
  if (countByPrefix(toolCallsByName, SUBAGENT_DELEGATION_TOOLS) === 0) return false;
  if (!userText) return false;
  if (!(DEBUG_FIX_INTENT_RE.test(userText) || IMPLEMENT_LOCATE_INTENT_RE.test(userText))) {
    return false;
  }
  if (SKIP_TESTS_USER_RE.test(userText)) return false;

  const finishing =
    SUCCESS_CLAIM_RE.test(response) ||
    /\b(?:all done|done\.|finished|completed|fixed|完成了|搞定|已修复|已实现)\b/iu.test(response);
  if (!finishing) return false;

  // Parent ran runtime suite tools — accept if latest such result is green enough.
  if ((toolCallsByName.run_tests ?? 0) > 0 || (toolCallsByName.verify_fix ?? 0) > 0) {
    const results = collectNamedToolResults(messages).filter(
      (r) => r.name === 'run_tests' || r.name === 'verify_fix',
    );
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i]!;
      if (isVerificationResultFailure(r.text, r.isError)) continue;
      if (r.name === 'verify_fix' && /Tests:\s*⏭/.test(r.text) && !/Tests:\s*✅\s*pass/.test(r.text)) {
        continue;
      }
      return false;
    }
  }

  // Parent test-shaped exec green?
  const execById = execCommandByUseId(messages);
  for (const [id, cmd] of execById) {
    if (!isRuntimeTestCommand(cmd)) continue;
    for (const r of collectNamedToolResults(messages)) {
      if (!EXEC_TOOLS.has(r.name)) continue;
      if (isVerificationResultFailure(r.text, r.isError)) continue;
      if (DELEGATED_RUNTIME_GREEN_RE.test(r.text) || /exit_code:\s*0/i.test(r.text)) {
        return false;
      }
    }
    void id;
  }

  // Child / background-status summary embedded green suite output?
  const results = collectNamedToolResults(messages);
  let sawDelegationResult = false;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]!;
    if (!SUBAGENT_AGGREGATION_RESULT_NAMES.has(r.name)) continue;
    // Non-terminal status snapshots (still running) are not completion evidence.
    if (r.name === 'subagent_status' && /\]\s*(RUNNING|PENDING|STARTED)\b/i.test(r.text)) {
      continue;
    }
    sawDelegationResult = true;
    if (r.isError) continue;
    if (DELEGATED_RUNTIME_GREEN_RE.test(r.text)) return false;
    // Latest terminal subagent result lacks suite green.
    break;
  }

  // create_subagent background-only: STARTED then done claim without status/wait.
  if (!sawDelegationResult && (toolCallsByName.create_subagent ?? 0) > 0) {
    return true;
  }
  if (!sawDelegationResult) return false;

  return true;
}

/**
 * Soft gate: edits under coding-change intent require a *fresh* green verification
 * result after the last code mutation (not a stale green from earlier in the run).
 * Also covers parent-only completion after delegated subagent mutations.
 */
export function evaluateCodingCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  const userText = lastUserText(request.messages);
  // Fix/implement intents need runtime tests after edits — lint-only green is not enough.
  const requireRuntimeTests = Boolean(
    userText &&
      (DEBUG_FIX_INTENT_RE.test(userText) || IMPLEMENT_LOCATE_INTENT_RE.test(userText)),
  );

  if (edits === 0) {
    // Parent may have delegated all mutations to subagents.
    if (
      hasUnverifiedDelegatedMutation(
        request.messages,
        request.toolCallsByName,
        userText,
        request.response,
      )
    ) {
      return {
        ok: false,
        reason: 'delegated mutation without parent verification',
        retryLimit: 1,
        correction:
          '[System] You delegated fix/implement work via `fan_out_subagents` / `create_subagent` and claimed done, ' +
          'but there is no parent-level runtime verification and no green test evidence in the child summaries. ' +
          'Before finishing: run `run_tests` or `verify_fix` yourself (or re-run children with scope=verify and green suite output), ' +
          'then report done with that evidence. Do not treat a successful merge of untested child prose as proof.',
      };
    }
    return { ok: true };
  }

  if (hasFreshGreenVerificationAfterLastEdit(request.messages, { requireRuntimeTests })) {
    return { ok: true };
  }

  if (!userText || !CODING_CHANGE_RE.test(userText)) return { ok: true };

  if (SKIP_TESTS_USER_RE.test(userText)) return { ok: true };

  // Admitting "I did not run tests" only escapes when the reply is clearly
  // incomplete / asking for permission — not when it also claims done/fixed.
  if (/\b(?:did not|didn't|no)\s+(?:run\s+)?tests?\b|未运行测试|没有跑测试/iu.test(request.response)) {
    const claimsDone =
      SUCCESS_CLAIM_RE.test(request.response) ||
      /\b(?:all done|done\.|finished|completed|fixed|完成了|搞定|已修复)\b/iu.test(
        request.response,
      );
    const incomplete =
      /\b(?:remaining|still (?:need|to do|working)|next steps?|not (?:yet )?done|WIP|should I|want me to)\b|未完成|还剩|下一步|要不要/iu.test(
        request.response,
      );
    if (!claimsDone || incomplete) return { ok: true };
  }

  const hadAnyVerify = hasVerificationEvidence(request.messages, request.toolCallsByName);
  // Lint/typecheck-only or verify_fix with Tests skipped — not runtime suite proof.
  const nonRuntimeOnly =
    requireRuntimeTests &&
    hadAnyVerify &&
    !hasFreshGreenVerificationAfterLastEdit(request.messages, { requireRuntimeTests: true }) &&
    hasFreshGreenVerificationAfterLastEdit(request.messages, { requireRuntimeTests: false });

  let reason: string;
  let correction: string;
  if (nonRuntimeOnly) {
    reason = 'diagnostics-only verification after fix/implement';
    correction =
      '[System] After a fix/implement edit you only have lint/typecheck-style green ' +
      '(`code_diagnostics` and/or `verify_fix` with Tests skipped, or bare `tsc`/`lint` exec). That is not enough runtime evidence. ' +
      'Before finishing: run `run_tests` or `verify_fix` with a real test step ' +
      '(or `exec` with a clear test command such as `npm test`), see green output, then report done.';
  } else if (hadAnyVerify) {
    reason = 'stale verification after later edits';
    correction =
      '[System] You edited code again after the last green verification. That earlier green is stale. ' +
      'Before finishing: re-run `run_tests` or `verify_fix` (preferred), or `exec` with a clear test/build/typecheck command, ' +
      'and only report done with the new green output. Do not claim success from an older verify result.';
  } else {
    reason = 'edited code without verification';
    correction =
      '[System] You edited code but did not run real verification. Before finishing: ' +
      'call `run_tests` or `verify_fix` (preferred), or `exec` with a clear test/build/typecheck command ' +
      '(e.g. `npm test`, `npm run verify`, `tsc`). Arbitrary shell (e.g. `echo`) does not count. ' +
      'See the real output, then report done with that evidence. Do not claim the change works without running it.';
  }

  return {
    ok: false,
    reason,
    retryLimit: 1,
    correction,
  };
}

/**
 * Soft gate: latest *runtime* verification tool result is red while finishing.
 * A later green code_diagnostics / bare tsc does not clear a still-red suite.
 * When this run edited code, reject even "quiet" done prose (no explicit success claim).
 */
export function evaluateVerificationOutcomeGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const all = collectNamedToolResults(request.messages);
  const latest = pickLatestRuntimeVerification(all);
  if (!latest) return { ok: true };

  if (!isVerificationResultFailure(latest.text, latest.isError)) return { ok: true };

  if (ADMITS_FAILURE_RE.test(request.response)) return { ok: true };

  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  // With edits: block quiet done on red. Without edits: only block explicit success claims.
  if (edits === 0 && !SUCCESS_CLAIM_RE.test(request.response)) return { ok: true };
  if (
    edits > 0 &&
    !SUCCESS_CLAIM_RE.test(request.response) &&
    !/\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response)
  ) {
    // Mid-investigation prose without a finish claim — allow.
    if (!/\b(?:done|fixed|pass|完成|通过)\b/iu.test(request.response)) return { ok: true };
  }

  const preview = failurePreview(latest.text);
  const reason =
    edits > 0 && !SUCCESS_CLAIM_RE.test(request.response)
      ? 'verification failed while finishing'
      : 'verification failed but success claimed';

  return {
    ok: false,
    reason,
    retryLimit: 1,
    correction:
      '[System] The latest runtime verification result is red. Do not report done while the suite is failing.\n' +
      `Latest ${latest.name} output (excerpt):\n${preview}\n` +
      'A later green `code_diagnostics` or bare `tsc` does not clear red tests. ' +
      'Fix the failures and re-run the test suite, or report the failure honestly with evidence.',
  };
}

/**
 * Soft gate: recent tool failures must not be ignored under a completion claim.
 */
export function evaluateFailureDrivenGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  // Questions / blockers already honest
  if (/\?\s*$|need (?:your|clarif)|请确认|是否继续/iu.test(request.response.trim())) {
    return { ok: true };
  }

  const all = collectNamedToolResults(request.messages);
  const recent = all.slice(-8);
  const failures = recent.filter((r) => isGenericToolFailure(r.text, r.outcome, r.isError));
  if (failures.length === 0) return { ok: true };

  // If latest verification is red, outcome gate owns success-claim; still catch
  // non-verify tool errors under done claims.
  const lastFailure = failures[failures.length - 1]!;
  if (
    lastFailure.isVerification &&
    isVerificationResultFailure(lastFailure.text, lastFailure.isError)
  ) {
    // Outcome gate owns red-verification + success claim; still fire here for
    // generic "done" without success-claim words.
    if (SUCCESS_CLAIM_RE.test(request.response)) {
      return { ok: true };
    }
  }

  if (ADMITS_FAILURE_RE.test(request.response)) return { ok: true };

  const doneClaim =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!doneClaim) return { ok: true };

  const preview = failurePreview(lastFailure.text);

  return {
    ok: false,
    reason: 'unresolved tool failure',
    retryLimit: 1,
    correction:
      '[System] A recent tool result failed, but you reported done without addressing it.\n' +
      `Failed tool (${lastFailure.name}) excerpt:\n${preview}\n` +
      'Continue from that error (retry with a corrected approach) or explicitly state the blocker. ' +
      'Do not claim the task is finished while a tool failure is unresolved.',
  };
}

/**
 * Soft gate: fix/bug/implement intent + edits with zero investigation tools.
 * Engineering-partner discipline — locate (or reproduce) before patching.
 */
export function evaluateDebugInvestigationGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  if (countByPrefix(request.toolCallsByName, INVESTIGATE_TOOLS) > 0) return { ok: true };

  const userText = lastUserText(request.messages);
  if (!userText) return { ok: true };

  const isDebug = DEBUG_FIX_INTENT_RE.test(userText);
  const isImplement = IMPLEMENT_LOCATE_INTENT_RE.test(userText);
  if (!isDebug && !isImplement) return { ok: true };

  // User already said the fix/path is known / one-liner — don't thrash.
  if (
    /(?:known fix|one[- ]?line|trivial|just change|直接改|已知修复|一行|I already (?:know|have) the path)/iu.test(
      userText,
    ) ||
    /(?:known fix|one[- ]?line|trivial|just change|直接改|已知修复|一行)/iu.test(request.response)
  ) {
    return { ok: true };
  }

  // Model already described investigation evidence in the reply — soft pass.
  if (
    /\b(?:read|searched|reproduced|stack trace|error was|callers?|callees?|根因|复现|定位|已读|搜过)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  // Only fire when finishing / claiming done — allow mid-run blind first edit
  // to be corrected by mid-run nudges, but block false complete.
  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定|已实现|已修复)\b/iu.test(request.response);
  if (!finishing && isImplement && !isDebug) return { ok: true };

  const kind = isDebug ? 'fix/bug' : 'implement/refactor';
  return {
    ok: false,
    reason: 'edited without investigation',
    retryLimit: 1,
    correction:
      `[System] You edited code for a ${kind} request without any investigation tools ` +
      '(`read_file`, `search_code`, `search_files`, CodeGraph, `exec` to reproduce, …). ' +
      'Before finishing: locate the relevant symbols/callers (or reproduce the bug), then apply a minimal change, ' +
      'or explicitly state this is a known one-line fix / known path with the evidence you already have. ' +
      'Do not blind-patch and report done.',
  };
}

/**
 * Soft gate: parent claimed done after fan_out/create_subagent with FAILED
 * children without acknowledging incomplete merge / re-running failed angles.
 */
export function evaluateFanOutMergeGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  // Only when finishing.
  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定|全部完成)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  // Honest incomplete merge / re-run plans pass.
  if (
    /\b(?:FAILED|failed child|re-run|rerun|retry failed|partial|not all|incomplete merge|still need)\b|失败子|重跑|未全部/iu.test(
      request.response,
    ) ||
    ADMITS_FAILURE_RE.test(request.response)
  ) {
    return { ok: true };
  }

  const results = collectNamedToolResults(request.messages);
  // Look at recent subagent aggregations (last few tool results).
  const recent = results.slice(-6);
  const failedFanOut = recent.find((r) => {
    if (r.name !== 'fan_out_subagents' && r.name !== 'create_subagent') return false;
    if (r.isError) return true;
    if (/Error:\s*\[fan_out_subagents\]/i.test(r.text)) return true;
    if (/\b\d+\s+ok,\s*[1-9]\d*\s+failed\b/i.test(r.text)) return true;
    if (/\[Sub-agent[^\]]*\]\s*FAILED/i.test(r.text)) return true;
    if (/empty output treated as failure/i.test(r.text)) return true;
    return false;
  });
  if (!failedFanOut) return { ok: true };

  const preview = failurePreview(failedFanOut.text, 5);
  return {
    ok: false,
    reason: 'fan-out children failed',
    retryLimit: 1,
    correction:
      '[System] A recent `fan_out_subagents` / `create_subagent` result has FAILED or empty children, ' +
      'but your reply claims the overall work is done.\n' +
      `Excerpt:\n${preview}\n` +
      'Merge only successful evidence, re-run or replace failed angles (or scope=full/verify with acceptance criteria), ' +
      'and do not invent success for FAILED/empty children.',
  };
}

/**
 * Compose host completion gates: structured-output is handled inside MossAgent
 * before this runs. Chain todo → coding evidence → running bg verify → outcome →
 * failure-driven → fan-out merge → debug investigation → extra.
 */
export function createCliCompletionGate(
  extra?: (
    request: CodingCompletionGateRequest,
  ) => Promise<CodingCompletionGateResult> | CodingCompletionGateResult,
  options?: {
    /** Called when a gate rejects completion (CLI can print a status line). */
    onReject?: (decision: Extract<CodingCompletionGateResult, { ok: false }>) => void;
  },
): (request: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> {
  return async (request) => {
    const chain: CodingCompletionGateResult[] = [
      evaluateTodoCompletionGate(request),
      evaluateCodingCompletionGate(request),
      evaluateRunningBackgroundVerifyGate(request),
      evaluateVerificationOutcomeGate(request),
      evaluateFailureDrivenGate(request),
      evaluateFanOutMergeGate(request),
      evaluateDebugInvestigationGate(request),
    ];
    for (const decision of chain) {
      if (!decision.ok) {
        options?.onReject?.(decision);
        return decision;
      }
    }
    if (extra) {
      const extraDecision = await extra(request);
      if (!extraDecision.ok) options?.onReject?.(extraDecision);
      return extraDecision;
    }
    return { ok: true };
  };
}
