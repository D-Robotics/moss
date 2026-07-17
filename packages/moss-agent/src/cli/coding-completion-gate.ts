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
 * Soft gate: do not finish while a background create_subagent is still running
 * (STARTED without a later terminal subagent_status SUCCESS/FAILED for that task).
 * Also block success claims when the parent stopped the child without admitting cancel.
 */
export function evaluateRunningBackgroundSubagentGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定|全部完成)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  // Honest wait / still-running / cancelled prose passes.
  if (
    /\b(?:still running|waiting|in progress|not (?:yet )?done|WIP|pending|cancelled|canceled|stopped|后台|等待|未完成|已取消|已停止)\b/iu.test(
      request.response,
    ) ||
    ADMITS_FAILURE_RE.test(request.response)
  ) {
    return { ok: true };
  }

  const results = collectNamedToolResults(request.messages);
  const startedIds = new Set<string>();
  const terminalIds = new Set<string>();
  const stoppedIds = new Set<string>();

  for (const r of results) {
    if (r.name === 'create_subagent') {
      const m = r.text.match(/\[Sub-agent task\s+([^\]]+)\]\s*STARTED/i);
      if (m?.[1]) startedIds.add(m[1].trim());
    }
    if (r.name === 'subagent_status') {
      // Terminal: SUCCESS or FAILED (with or without Error: prefix)
      const m = r.text.match(
        /\[Sub-agent task\s+([^\]]+)\]\s*(?:SUCCESS|FAILED)/i,
      );
      if (m?.[1]) terminalIds.add(m[1].trim());
    }
    if (r.name === 'subagent_stop') {
      const m = r.text.match(
        /\[Sub-agent task\s+([^\]]+)\]\s*(?:STOPPED|STOP REQUESTED|ALREADY\s+\w+)/i,
      );
      if (m?.[1]) stoppedIds.add(m[1].trim());
    }
  }

  const stillRunning = [...startedIds].filter(
    (id) => !terminalIds.has(id) && !stoppedIds.has(id),
  );
  if (stillRunning.length > 0) {
    const preview = stillRunning
      .slice(0, 4)
      .map((id) => `- ${id}`)
      .join('\n');
    const more =
      stillRunning.length > 4 ? `\n- …and ${stillRunning.length - 4} more` : '';

    return {
      ok: false,
      reason: 'background subagent still running',
      retryLimit: 1,
      correction:
        '[System] A background `create_subagent` is still running (STARTED without a terminal `subagent_status`). ' +
        'Do not report done yet.\n' +
        `Open task id(s):\n${preview}${more}\n` +
        'Call `subagent_status` with wait=true (or wait for completion), read SUCCESS/FAILED + evidence, then continue or report honestly.',
    };
  }

  // Stopped/cancelled children: do not claim the fix succeeded unless admitting cancel
  // or having independent runtime suite evidence.
  const stoppedWithoutSuccess = [...stoppedIds].filter((id) => !terminalIds.has(id));
  // terminalIds with SUCCESS after stop is rare; if status shows SUCCESS, allow.
  // If only STOPPED, treat as incomplete for success claims about the task.
  if (stoppedWithoutSuccess.length > 0 && SUCCESS_CLAIM_RE.test(request.response)) {
    const hasParentSuite =
      (request.toolCallsByName.run_tests ?? 0) > 0 ||
      (request.toolCallsByName.verify_fix ?? 0) > 0;
    if (!hasParentSuite) {
      const preview = stoppedWithoutSuccess
        .slice(0, 4)
        .map((id) => `- ${id}`)
        .join('\n');
      return {
        ok: false,
        reason: 'background subagent stopped without success',
        retryLimit: 1,
        correction:
          '[System] You stopped a background sub-agent (`subagent_stop`) and claimed the work is done/fixed, ' +
          'but there is no successful terminal result and no parent `run_tests`/`verify_fix` evidence.\n' +
          `Stopped task id(s):\n${preview}\n` +
          'Either re-run the child to completion, run verification yourself, or report that the sub-agent was cancelled and the work is incomplete.',
      };
    }
  }

  return { ok: true };
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
 * Soft gate: do not invent smoke/load/perf-test outcomes without matching exec.
 * Catches "I ran smoke tests" / "I ran k6 load tests and they passed".
 */
export function evaluateInventedSmokeLoadCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run )?(?:smoke|load|perf) tests?|no smoke|no load test|未跑冒烟|没有压测)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsSmokeLoad =
    /\b(?:I (?:ran|executed) (?:the )?(?:smoke|load|perf(?:ormance)?) tests?|smoke tests? (?:passed|green|ok)|load tests? (?:passed|ok)|k6 (?:passed|ok)|artillery (?:passed|ok)|wrk (?:passed|ok)|冒烟(?:测试)?通过|压测通过)\b/iu.test(
      request.response,
    );
  if (!claimsSmokeLoad) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsSmokeLoad ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  if ((request.toolCallsByName.run_tests ?? 0) > 0 || (request.toolCallsByName.verify_fix ?? 0) > 0) {
    return { ok: true };
  }

  const execById = execCommandByUseId(request.messages);
  let sawSmokeLoadExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bsmoke\b/i.test(cmd) ||
      /\b(?:k6|artillery|wrk|ab|hey|vegeta|locust)\b/i.test(cmd) ||
      /\bnpm run (?:smoke|test:smoke|load|perf)\b|\bpnpm (?:run )?(?:smoke|test:smoke|load|perf)\b|\byarn (?:smoke|test:smoke|load|perf)\b/i.test(
        cmd,
      )
    ) {
      sawSmokeLoadExec = true;
      break;
    }
  }
  if (sawSmokeLoadExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed smoke/load test without matching exec',
    retryLimit: 1,
    correction:
      '[System] You claimed smoke/load/perf tests passed, but no matching smoke/load command ' +
      '(`npm run smoke`, `k6`, `artillery`, `wrk`, etc.) or `run_tests`/`verify_fix` ran this turn. ' +
      'Run the real smoke/load suite and report its output, or clearly say it was not run. ' +
      'Do not invent smoke/load results.',
  };
}

/**
 * Soft gate: do not invent security-audit outcomes without an audit-shaped exec.
 * Catches "I ran npm audit / cargo audit and there are no vulnerabilities".
 */
export function evaluateInventedAuditCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run )?audit|no audit|未跑 audit|没有安全审计)\b/iu.test(request.response)
  ) {
    return { ok: true };
  }

  const claimsAudit =
    /\b(?:I (?:ran|executed) (?:npm|pnpm|yarn|cargo|pip) audit|I (?:ran|did) (?:a )?security audit|audit (?:passed|clean|ok|found 0)|no (?:known )?vulnerabilit(?:y|ies)|安全审计通过|无漏洞|audit 通过)\b/iu.test(
      request.response,
    );
  if (!claimsAudit) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsAudit ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawAuditExec = false;
  for (const cmd of execById.values()) {
    if (
      /\b(?:npm|pnpm|yarn|bun)\s+audit\b/i.test(cmd) ||
      /\bcargo\s+audit\b/i.test(cmd) ||
      /\bpip-audit\b/i.test(cmd) ||
      /\bsnyk\s+test\b/i.test(cmd) ||
      /\bosv-scanner\b/i.test(cmd) ||
      /\btrivy\b/i.test(cmd) ||
      /\bnpm run audit\b/i.test(cmd)
    ) {
      sawAuditExec = true;
      break;
    }
  }
  if (sawAuditExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed security audit without audit exec',
    retryLimit: 1,
    correction:
      '[System] You claimed a security audit passed or found no vulnerabilities, but no audit-shaped command ' +
      '(`npm audit`, `cargo audit`, `snyk test`, `trivy`, etc.) ran via `exec` this turn. ' +
      'Run a real audit and report its output, or clearly say no audit was run. ' +
      'Do not invent vulnerability scan results.',
  };
}

/**
 * Soft gate: do not invent coverage outcomes without a coverage-shaped exec.
 */
export function evaluateInventedCoverageCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run )?coverage|no coverage|未跑覆盖率|没有 coverage)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsCoverage =
    /\b(?:I (?:ran|collected) coverage|coverage (?:is|was) (?:\d{1,3}%|100%|full)|(?:nyc|c8|istanbul|coverage) (?:passed|ok|complete)|覆盖率(?:达到|为)|已跑覆盖率)\b/iu.test(
      request.response,
    );
  if (!claimsCoverage) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsCoverage ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  if ((request.toolCallsByName.run_tests ?? 0) > 0 || (request.toolCallsByName.verify_fix ?? 0) > 0) {
    return { ok: true };
  }

  const execById = execCommandByUseId(request.messages);
  let sawCoverageExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bcoverage\b/i.test(cmd) ||
      /\b(?:nyc|c8|istanbul)\b/i.test(cmd) ||
      /\b(?:jest|vitest)\b[^\n]*--coverage\b/i.test(cmd) ||
      /\bnpm run (?:test:)?coverage\b|\bpnpm (?:run )?(?:test:)?coverage\b|\byarn (?:test:)?coverage\b/i.test(
        cmd,
      )
    ) {
      sawCoverageExec = true;
      break;
    }
  }
  if (sawCoverageExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed coverage without coverage exec',
    retryLimit: 1,
    correction:
      '[System] You claimed test coverage was collected or met a threshold, but no coverage-shaped command ' +
      '(`--coverage`, `c8`, `nyc`, `npm run coverage`, etc.) or `run_tests`/`verify_fix` ran this turn. ' +
      'Run real coverage and report the numbers, or clearly say coverage was not measured. ' +
      'Do not invent coverage percentages.',
  };
}

/**
 * Soft gate: do not invent snapshot-update outcomes without a snapshot-shaped exec.
 */
export function evaluateInventedSnapshotCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:update )?snapshots?|no snapshot update|未更新 snapshot|没有更新快照)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsSnapshot =
    /\b(?:I (?:updated|regenerated) (?:the )?snapshots?|snapshots? (?:updated|regenerated)|jest -u|vitest -u|更新了 snapshot|快照已更新)\b/iu.test(
      request.response,
    );
  if (!claimsSnapshot) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsSnapshot ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawSnapshotExec = false;
  for (const cmd of execById.values()) {
    if (
      /\b(?:jest|vitest)\b[^\n]*\s-u\b/i.test(cmd) ||
      /\b--update(?:Snapshot|s)?\b/i.test(cmd) ||
      /\bupdate[- ]?snapshots?\b/i.test(cmd) ||
      /\bnpm run (?:test:)?update-?snapshots?\b/i.test(cmd)
    ) {
      sawSnapshotExec = true;
      break;
    }
  }
  if (sawSnapshotExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed snapshot update without snapshot exec',
    retryLimit: 1,
    correction:
      '[System] You claimed test snapshots were updated, but no snapshot-update command ' +
      '(`jest -u`, `vitest -u`, `--updateSnapshot`, etc.) ran via `exec` this turn. ' +
      'Run the real snapshot update and report its output, or clearly say snapshots were not updated. ' +
      'Do not invent snapshot updates.',
  };
}

/**
 * Soft gate: do not invent e2e/browser-test outcomes without a matching exec.
 * Catches "I ran playwright/cypress and e2e passed" without e2e-shaped commands.
 */
export function evaluateInventedE2eCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run )?e2e|no e2e|未跑 e2e|没有跑 playwright|没有跑 cypress)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsE2e =
    /\b(?:I (?:ran|executed) (?:the )?(?:e2e|playwright|cypress)|e2e (?:tests? )?(?:passed|green|ok|succeeded)|playwright (?:passed|ok)|cypress (?:passed|ok)|端到端(?:测试)?通过|e2e 通过)\b/iu.test(
      request.response,
    );
  if (!claimsE2e) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsE2e ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  // run_tests may wrap e2e — count it as evidence when present.
  if ((request.toolCallsByName.run_tests ?? 0) > 0 || (request.toolCallsByName.verify_fix ?? 0) > 0) {
    return { ok: true };
  }

  const execById = execCommandByUseId(request.messages);
  let sawE2eExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bplaywright\b/i.test(cmd) ||
      /\bcypress\b/i.test(cmd) ||
      /\bpuppeteer\b/i.test(cmd) ||
      /\be2e\b/i.test(cmd) ||
      /\bnpm run (?:e2e|test:e2e)\b|\bpnpm (?:run )?(?:e2e|test:e2e)\b|\byarn (?:e2e|test:e2e)\b/i.test(
        cmd,
      )
    ) {
      sawE2eExec = true;
      break;
    }
  }
  if (sawE2eExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed e2e without e2e exec',
    retryLimit: 1,
    correction:
      '[System] You claimed e2e/playwright/cypress tests passed, but no matching e2e command ' +
      '(`playwright`, `cypress`, `npm run e2e`, etc.) or `run_tests`/`verify_fix` ran this turn. ' +
      'Run the real e2e suite and report its output, or clearly say e2e was not run. ' +
      'Do not invent e2e results.',
  };
}

/**
 * Soft gate: do not invent codegen outcomes without a codegen-shaped exec.
 * Catches "I ran prisma generate / graphql-codegen / openapi generate".
 */
export function evaluateInventedCodegenCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run|generate) (?:types|codegen|client)|no codegen|未生成|没有 codegen|没有 generate)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsCodegen =
    /\b(?:I (?:ran|executed) (?:prisma generate|graphql-codegen|openapi[- ]?generator|buf generate|protoc)|I generated (?:the )?(?:types|client|SDK|protobuf)|codegen (?:succeeded|complete|done)|prisma generate (?:succeeded|ok)|生成了类型|代码生成完成)\b/iu.test(
      request.response,
    );
  if (!claimsCodegen) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsCodegen ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawCodegenExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bprisma\s+generate\b/i.test(cmd) ||
      /\bgraphql-codegen\b/i.test(cmd) ||
      /\bopenapi-generator\b/i.test(cmd) ||
      /\bbuf\s+generate\b/i.test(cmd) ||
      /\bprotoc\b/i.test(cmd) ||
      /\bnpm run (?:codegen|generate)\b|\bpnpm (?:run )?(?:codegen|generate)\b|\byarn (?:codegen|generate)\b/i.test(
        cmd,
      )
    ) {
      sawCodegenExec = true;
      break;
    }
  }
  if (sawCodegenExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed codegen without codegen exec',
    retryLimit: 1,
    correction:
      '[System] You claimed code generation (prisma generate / graphql-codegen / openapi / protobuf) succeeded, ' +
      'but no matching generate command ran via `exec` this turn. ' +
      'Run the real codegen command and report its output, or clearly say generation was not run. ' +
      'Do not invent generated clients/types.',
  };
}

/**
 * Soft gate: do not invent DB seed outcomes without a seed-shaped exec.
 */
export function evaluateInventedSeedCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run|seed)|no seed|未 seed|没有灌数据|未执行 seed)\b/iu.test(request.response)
  ) {
    return { ok: true };
  }

  const claimsSeed =
    /\b(?:I (?:ran|executed|seeded) (?:the )?(?:database|db|seed)|seed(?:ing)? (?:succeeded|complete|done)|prisma db seed|seeded (?:the )?data|已 seed|灌数完成|种子数据已写入)\b/iu.test(
      request.response,
    );
  if (!claimsSeed) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsSeed ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawSeedExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bseed\b/i.test(cmd) ||
      /\bprisma\s+db\s+seed\b/i.test(cmd) ||
      /\bknex\s+seed\b/i.test(cmd) ||
      /\bnpm run seed\b|\bpnpm (?:run )?seed\b|\byarn seed\b/i.test(cmd)
    ) {
      sawSeedExec = true;
      break;
    }
  }
  if (sawSeedExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed seed without seed exec',
    retryLimit: 1,
    correction:
      '[System] You claimed database seeding succeeded, but no seed-shaped command ' +
      '(`prisma db seed`, `knex seed`, `npm run seed`, etc.) ran via `exec` this turn. ' +
      'Run the real seed command and report its output, or clearly say seeding was not run. ' +
      'Do not invent seed success.',
  };
}

/**
 * Soft gate: do not invent formatter outcomes without a format-shaped exec.
 * Catches "I ran prettier / formatted the codebase" without matching commands.
 */
export function evaluateInventedFormatCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not format|no format|未格式化|没有跑 prettier|没有 format)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsFormat =
    /\b(?:I (?:ran|executed) (?:prettier|eslint --fix|gofmt|rustfmt|black|ruff format)|I formatted (?:the )?(?:code|files|codebase)|prettier (?:passed|ok|done)|formatted (?:all|the) files|已格式化|格式化完成)\b/iu.test(
      request.response,
    );
  if (!claimsFormat) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsFormat ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawFormatExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bprettier\b/i.test(cmd) ||
      /\beslint\b[^\n]*--fix\b/i.test(cmd) ||
      /\b(?:gofmt|rustfmt|black|ruff\s+format|clang-format)\b/i.test(cmd) ||
      /\bnpm run format\b|\bpnpm (?:run )?format\b|\byarn format\b/i.test(cmd)
    ) {
      sawFormatExec = true;
      break;
    }
  }
  if (sawFormatExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed format without format exec',
    retryLimit: 1,
    correction:
      '[System] You claimed to format the codebase (prettier/eslint --fix/etc.), but no matching format command ran via `exec` this turn. ' +
      'Run the real formatter and report its output, or clearly say formatting was not run. Do not invent format results.',
  };
}

/**
 * Soft gate: do not invent DB migration outcomes without a migrate-shaped exec.
 */
export function evaluateInventedMigrateCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run|apply) migrations?|no migrations?|未跑迁移|没有 migrate)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsMigrate =
    /\b(?:I (?:ran|applied|executed) (?:the )?migrations?|migration(?:s)? (?:succeeded|complete|applied)|prisma migrate|drizzle-kit|knex migrate|已执行迁移|迁移成功)\b/iu.test(
      request.response,
    );
  if (!claimsMigrate) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsMigrate ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawMigrateExec = false;
  for (const cmd of execById.values()) {
    if (
      /\bmigrate\b/i.test(cmd) ||
      /\bprisma\s+migrate\b/i.test(cmd) ||
      /\bdrizzle-kit\b/i.test(cmd) ||
      /\bknex\s+migrate\b/i.test(cmd) ||
      /\balembic\s+upgrade\b/i.test(cmd) ||
      /\btypeorm\s+migration\b/i.test(cmd)
    ) {
      sawMigrateExec = true;
      break;
    }
  }
  if (sawMigrateExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed migration without migrate exec',
    retryLimit: 1,
    correction:
      '[System] You claimed database migrations were applied, but no migrate-shaped command ' +
      '(`prisma migrate`, `drizzle-kit`, `knex migrate`, `alembic upgrade`, etc.) ran via `exec` this turn. ' +
      'Run the real migration command and report its output, or clearly say migrations were not run. ' +
      'Do not invent migration success.',
  };
}

/**
 * Soft gate: do not invent package publish / deploy outcomes without matching exec.
 * Catches "I published to npm" / "I deployed to production" without publish/deploy-shaped commands.
 */
export function evaluateInventedPublishDeployCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:publish|deploy)|no publish|no deploy|未发布|未部署|没有 publish|没有部署)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsPublish =
    /\b(?:I (?:published|released) (?:to )?(?:npm|pypi|crates\.io|the registry)|npm publish (?:succeeded|ok|done)|published (?:the )?(?:package|version)|已发布到 npm|发布成功)\b/iu.test(
      request.response,
    );
  const claimsDeploy =
    /\b(?:I (?:deployed|shipped) (?:to )?(?:production|staging|prod|k8s|kubernetes|vercel|netlify|cloud)|deploy (?:succeeded|complete|done)|deployment (?:is )?(?:live|successful)|已部署|部署成功|上线了)\b/iu.test(
      request.response,
    );

  if (!claimsPublish && !claimsDeploy) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsPublish ||
    claimsDeploy ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawPublishOrDeploy = false;
  for (const cmd of execById.values()) {
    if (
      /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i.test(cmd) ||
      /\bcargo\s+publish\b/i.test(cmd) ||
      /\btwine\s+upload\b/i.test(cmd) ||
      /\b(?:kubectl|helm)\s+(?:apply|upgrade|install|rollout)\b/i.test(cmd) ||
      /\b(?:vercel|netlify|flyctl|gcloud|aws|terraform|pulumi)\b/i.test(cmd) ||
      /\b(?:deploy|gh\s+workflow\s+run)\b/i.test(cmd)
    ) {
      sawPublishOrDeploy = true;
      break;
    }
  }
  if (sawPublishOrDeploy) return { ok: true };

  return {
    ok: false,
    reason: 'claimed publish/deploy without matching exec',
    retryLimit: 1,
    correction:
      '[System] You claimed a package publish or production deploy, but no matching publish/deploy command ' +
      '(`npm publish`, `cargo publish`, `kubectl apply`, `vercel`, etc.) ran via `exec` this turn. ' +
      'Run the real publish/deploy command and report its output, or clearly say it was not published/deployed. ' +
      'Do not invent release or deployment outcomes.',
  };
}

/**
 * Soft gate: do not invent docker/container outcomes without docker/podman exec.
 */
export function evaluateInventedDockerCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:run|use) docker|no docker|未使用 docker|没有跑容器)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsDocker =
    /\b(?:I (?:ran|built|pushed|pulled) (?:the )?(?:docker|container|image)|docker (?:build|run|compose) (?:succeeded|ok|done)|container is running|容器(?:已)?(?:启动|运行)|docker 构建成功)\b/iu.test(
      request.response,
    );
  if (!claimsDocker) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsDocker ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawDockerExec = false;
  for (const cmd of execById.values()) {
    if (/\b(?:docker|podman|docker-compose|compose)\b/i.test(cmd)) {
      sawDockerExec = true;
      break;
    }
  }
  if (sawDockerExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed docker action without docker exec',
    retryLimit: 1,
    correction:
      '[System] You claimed a docker/container build/run result, but no `exec`/`exec_background` command containing `docker`/`podman`/`compose` ran this turn. ' +
      'Run the real container commands and report their output, or clearly say containers were not started. ' +
      'Do not invent container state.',
  };
}

/**
 * Soft gate: do not invent "dev server started / service is running" without
 * exec_background (or a still-running background process).
 */
export function evaluateInventedBackgroundServerCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not start (?:the )?(?:server|service)|no (?:dev )?server|未启动服务|没有起服务)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsServer =
    /\b(?:I (?:started|launched) (?:the )?(?:dev server|server|watcher|service)|(?:dev )?server is running|listening on port|服务(?:已)?启动|开发服务器(?:已)?运行|在后台跑着)\b/iu.test(
      request.response,
    );
  if (!claimsServer) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsServer ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  // Prefer explicit background tool; also accept exec with run_in_background.
  let sawBgStart = (request.toolCallsByName.exec_background ?? 0) > 0;
  if (!sawBgStart) {
    for (const m of request.messages) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        const b = block as { type?: string; name?: string; input?: unknown };
        if (b?.type !== 'tool_use' || b.name !== 'exec') continue;
        const input = b.input;
        if (input && typeof input === 'object') {
          const o = input as Record<string, unknown>;
          if (o.run_in_background === true || o.background === true) {
            sawBgStart = true;
            break;
          }
        }
      }
      if (sawBgStart) break;
    }
  }

  // Any still-running bg process is evidence something was started in background.
  if (!sawBgStart) {
    try {
      const running = listBackgroundProcessSnapshots().filter((p) => p.status === 'running');
      if (running.length > 0) sawBgStart = true;
    } catch {
      // ignore
    }
  }

  if (sawBgStart) return { ok: true };

  return {
    ok: false,
    reason: 'claimed background server without exec_background',
    retryLimit: 1,
    correction:
      '[System] You claimed a dev server/service is running in the background, but no `exec_background` ' +
      '(or `exec` with run_in_background) start was observed this turn. ' +
      'Start it with `exec_background` / background exec and report the handle, or clearly say it was not started. ' +
      'Do not invent a running server.',
  };
}

/**
 * Soft gate: do not invent CodeGraph navigation results without codegraph tools.
 */
export function evaluateInventedCodegraphCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:use|run) codegraph|no codegraph|未使用 codegraph|没有查 call graph)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const usedCodegraph = Object.keys(request.toolCallsByName).some((n) =>
    n.startsWith('codegraph_'),
  );
  if (usedCodegraph) return { ok: true };

  const claimsCodegraph =
    /\b(?:codegraph_(?:search|callers|callees|trace|impact|node|context|explore|files)|I (?:traced|queried) (?:the )?call graph|callers of|callees of|via CodeGraph|用 CodeGraph|查了调用图)\b/iu.test(
      request.response,
    );
  if (!claimsCodegraph) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsCodegraph ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  return {
    ok: false,
    reason: 'claimed codegraph results without codegraph tools',
    retryLimit: 1,
    correction:
      '[System] You claimed CodeGraph navigation results (callers/callees/trace/impact/search), ' +
      'but no `codegraph_*` tools ran this turn. Call the CodeGraph tools for real graph evidence, ' +
      'or restate from `search_code`/`read_file` without inventing call-graph facts.',
  };
}

/**
 * Soft gate: do not invent package-manager install outcomes without a matching exec.
 * Catches "I ran npm install / pnpm i / yarn install" when no install-shaped
 * exec ran this turn.
 */
export function evaluateInventedInstallCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (
    /\b(?:did not (?:install|run install)|no install|未安装依赖|没有 npm install)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsInstall =
    /\b(?:I (?:ran|executed) (?:npm|pnpm|yarn|bun)(?:\s+run)?\s+install\b|I (?:installed|ran) (?:the )?dependencies|npm install (?:succeeded|ok|done)|pnpm i(?:nstall)? (?:succeeded|ok)|yarn install (?:succeeded|ok)|依赖(?:已)?安装(?:完成|成功)|安装了依赖)\b/iu.test(
      request.response,
    );
  if (!claimsInstall) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsInstall ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawInstallExec = false;
  for (const cmd of execById.values()) {
    // Match real package-manager install; avoid bare "install" in unrelated paths.
    if (
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/i.test(cmd) ||
      /\bpip(?:3)?\s+install\b/i.test(cmd) ||
      /\bcargo\s+add\b/i.test(cmd)
    ) {
      sawInstallExec = true;
      break;
    }
  }
  if (sawInstallExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed package install without install exec',
    retryLimit: 1,
    correction:
      '[System] You claimed to install dependencies (`npm`/`pnpm`/`yarn`/`bun` install), but no matching install command ran via `exec`/`exec_background` this turn. ' +
      'Run the real package-manager install and report its output, or clearly say dependencies were not installed. ' +
      'Do not invent install success.',
  };
}

/**
 * Soft gate: do not invent git/VCS outcomes without a git-shaped exec.
 * Catches "I committed/pushed/opened a PR" when no exec/exec_background
 * command containing git (or gh pr) ran this turn.
 */
export function evaluateInventedGitCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  // Honest admission that git was not run.
  if (
    /\b(?:did not (?:commit|push|open a pr)|no commit|未提交|没有 push|未创建 PR)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsGit =
    /\b(?:I (?:committed|pushed|opened (?:a )?PR|created (?:a )?pull request|merged|rebased)|git (?:commit|push|merge|rebase)|gh pr create|committed (?:the )?changes|pushed (?:to )?(?:origin|remote)|已提交|已 push|创建了 PR|推送了|合并了|rebase 了)\b/iu.test(
      request.response,
    );
  if (!claimsGit) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsGit ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  const execById = execCommandByUseId(request.messages);
  let sawGitExec = false;
  for (const cmd of execById.values()) {
    if (/\bgit\b|\bgh\s+pr\b/i.test(cmd)) {
      sawGitExec = true;
      break;
    }
  }
  // Also count tool_use names if any dedicated git tool appears later.
  if (
    (request.toolCallsByName.git_commit ?? 0) > 0 ||
    (request.toolCallsByName.git_push ?? 0) > 0
  ) {
    sawGitExec = true;
  }
  if (sawGitExec) return { ok: true };

  return {
    ok: false,
    reason: 'claimed git action without git exec',
    retryLimit: 1,
    correction:
      '[System] You claimed a git commit/push/PR, but no `exec`/`exec_background` command containing `git` or `gh pr` ran this turn. ' +
      'Run the real git/gh commands (and report their output), or clearly say you have not committed/pushed. ' +
      'Do not invent VCS history.',
  };
}

/**
 * Soft gate: do not invent file mutations without edit tools.
 * Catches "I edited/wrote X.ts" when no edit_file/write_file/multi_edit/
 * apply_patch/move_file ran this turn.
 */
export function evaluateInventedEditCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits > 0) return { ok: true };

  // Honest "I did not edit" / "only analyzed" passes.
  if (
    /\b(?:did not (?:edit|write|change|modify)|no (?:edits?|changes)|only (?:read|analyzed)|未修改|没有改|仅分析)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsFileMutation =
    /\b(?:I (?:edited|wrote|updated|modified|patched|created|added|deleted|renamed|moved)\b.+\.(?:ts|tsx|js|jsx|py|go|rs|java|md|json|yml|yaml|toml|css|html)\b|\bedited\b.+\.(?:ts|tsx|js|jsx|py)\b|\bwrote\b.+\.(?:ts|tsx|js|jsx|py)\b|修改了.+\.(?:ts|tsx|js|py|md)|写入了.+\.(?:ts|js|py)|创建了.+\.(?:ts|js|py))\b/iu.test(
      request.response,
    ) ||
    /\b(?:I (?:applied|landed) (?:the )?(?:patch|diff|change)|apply_patch (?:succeeded|ok)|已应用补丁|已落地修改)\b/iu.test(
      request.response,
    );

  if (!claimsFileMutation) return { ok: true };

  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    /\b(?:all done|done\.|finished|completed|fixed|完成了|搞定|已修复)\b/iu.test(
      request.response,
    );
  // Strong path-level mutation claims always blocked; weaker finish+mutation phrasing too.
  if (!finishing && !/\.(?:ts|tsx|js|jsx|py)\b/i.test(request.response)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'claimed file edit without edit tools',
    retryLimit: 1,
    correction:
      '[System] You claimed to edit/write/patch a workspace file, but no `edit_file` / `write_file` / `multi_edit` / `apply_patch` / `move_file` ran this turn. ' +
      'Perform the real edit tools (after reading the file), or restate clearly that you only analyzed/suggested changes. ' +
      'Do not invent on-disk mutations.',
  };
}

/**
 * Soft gate: do not invent verification outcomes without verify tools.
 * Catches "tests passed" / "typecheck clean" claims when no run_tests /
 * verify_fix / code_diagnostics / verification-shaped exec ran.
 */
export function evaluateInventedVerificationCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  if (hasVerificationEvidence(request.messages, request.toolCallsByName)) {
    return { ok: true };
  }

  // Honest admission that tests/build were not run.
  if (
    /\b(?:did not|didn't|no)\s+(?:run\s+)?(?:tests?|build|typecheck|lint)\b|未运行测试|没有跑测试|未验证|未构建|I did not verify/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsTestsPassed =
    /\b(?:all )?tests?\s+pass(?:ed|ing)?\b|\btest suite (?:is )?(?:green|clean|passed)\b|\bnpm test (?:passed|ok|succeeded)\b|测试(?:全部)?通过|全部测试通过/iu.test(
      request.response,
    );
  const claimsDiagnosticsClean =
    /\b(?:typecheck|lint|diagnostics?)\s+(?:is |are )?(?:clean|green|passed|ok)\b|\btsc (?:passed|ok|succeeded)\b|类型检查通过|诊断通过|无诊断问题/iu.test(
      request.response,
    );
  const claimsBuildPassed =
    /\b(?:build (?:passed|succeeded|ok|green)|npm run build (?:passed|ok|succeeded)|compiled successfully|构建成功|编译通过)\b/iu.test(
      request.response,
    );
  const claimsVerified =
    /\b(?:I (?:ran|executed) (?:the )?(?:tests?|typecheck|lint|verify|build)|verified with (?:tests?|npm)|已运行测试|已类型检查|验证通过|已构建)\b/iu.test(
      request.response,
    );

  if (!claimsTestsPassed && !claimsDiagnosticsClean && !claimsBuildPassed && !claimsVerified) {
    return { ok: true };
  }

  // Only when finishing / success-claiming — mid-investigation "tests might pass" is fine.
  const finishing =
    SUCCESS_CLAIM_RE.test(request.response) ||
    claimsTestsPassed ||
    claimsDiagnosticsClean ||
    claimsBuildPassed ||
    /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response);
  if (!finishing) return { ok: true };

  return {
    ok: false,
    reason: 'claimed verification without verification tools',
    retryLimit: 1,
    correction:
      '[System] You claimed tests/typecheck/lint/build/diagnostics passed (or that you ran verification), ' +
      'but no `run_tests` / `verify_fix` / `code_diagnostics` / verification-shaped `exec` ran this turn. ' +
      'Run real verification tools and cite their output, or clearly say you have not verified yet. ' +
      'Do not invent green test/build/diagnostic results.',
  };
}

/**
 * Soft gate: web research honesty for this turn.
 * - Claims web search/fetch results or cites live web without web tools.
 */
export function evaluateWebToolsCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const usedWeb =
    (request.toolCallsByName.web_search ?? 0) + (request.toolCallsByName.web_fetch ?? 0) > 0;

  if (
    /\b(?:from local knowledge only|without searching|did not search|未联网|未搜索|仅本地)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsWebEvidence =
    /\b(?:I (?:searched|fetched) (?:the )?web|web_search (?:found|returned)|according to (?:the )?(?:web|search results|fetched page)|from (?:the )?official (?:site|docs) I (?:just )?fetched|联网搜索|网上查到|我搜索了网页|抓取了页面)\b/iu.test(
      request.response,
    ) ||
    (/\bhttps?:\/\/\S+/i.test(request.response) &&
      /\b(?:I (?:found|fetched|opened|read)|search (?:shows|found)|结果来自)\b/iu.test(
        request.response,
      ));

  if (claimsWebEvidence && !usedWeb) {
    return {
      ok: false,
      reason: 'claimed web evidence without web tools',
      retryLimit: 1,
      correction:
        '[System] You claimed web search/fetch evidence or cited live web results, but `web_search` / `web_fetch` were not used this turn. ' +
        'Call those tools for real sources, or restate clearly from local knowledge without inventing URLs or online findings.',
    };
  }

  return { ok: true };
}

/**
 * Soft gate: device/fleet honesty for this turn.
 * - Claims board exec/telemetry/fleet batch without device tools.
 */
export function evaluateDeviceCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const usedDevice =
    (request.toolCallsByName.device_exec ?? 0) +
      (request.toolCallsByName.device_info ?? 0) +
      (request.toolCallsByName.device_file_read ?? 0) +
      (request.toolCallsByName.device_file_list ?? 0) +
      (request.toolCallsByName.device_temperature ?? 0) +
      (request.toolCallsByName.device_resources ?? 0) +
      (request.toolCallsByName.device_processes ?? 0) +
      (request.toolCallsByName.device_network ?? 0) +
      (request.toolCallsByName.device_cameras ?? 0) +
      (request.toolCallsByName.device_robotics_status ?? 0) +
      (request.toolCallsByName.fleet_batch ?? 0) >
    0;

  if (
    /\b(?:without device tools?|did not (?:ssh|connect|run on) (?:the )?board|未连接板子|未执行设备命令)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsDeviceAction =
    /\b(?:I (?:ran|executed) on (?:the )?(?:board|device)|device_exec|ssh(?:ed)? (?:to )?(?:the )?board|on the board I|board reports|fleet_batch|在板子上(?:执行|运行)|设备上执行|开发板(?:显示|报告))\b/iu.test(
      request.response,
    ) ||
    /\b(?:temperature|cpu load|ros2 topic) (?:is|was|shows)\b.+\b(?:board|device|rdk)\b/iu.test(
      request.response,
    );

  if (claimsDeviceAction && !usedDevice) {
    return {
      ok: false,
      reason: 'claimed device action without device tools',
      retryLimit: 1,
      correction:
        '[System] You claimed board/device/fleet actions or telemetry, but no `device_*` / `fleet_batch` tools ran this turn. ' +
        'Call the device tools (after connect if needed), or restate without inventing board state. ' +
        'Do not invent SSH results or ROS/device telemetry.',
    };
  }

  return { ok: true };
}

/**
 * Soft gate: browser/vision honesty for this turn.
 * - Claims browser clicked/filled/navigated without browser tools.
 * - Claims screenshot/vision analysis without vision tools.
 */
export function evaluateBrowserVisionCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const usedBrowser =
    (request.toolCallsByName.web_browser_control ?? 0) +
      (request.toolCallsByName.web_browser_fetch ?? 0) >
    0;
  const usedVision =
    (request.toolCallsByName.vision_analyze ?? 0) +
      (request.toolCallsByName.screenshot_capture ?? 0) >
    0;

  if (
    /\b(?:without browser tools?|did not (?:open|use) (?:the )?browser|未使用浏览器|prose only)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsBrowserAction =
    /\b(?:I (?:clicked|filled|typed|navigated|submitted|logged in)|browser (?:clicked|filled|opened)|clicked the|filled the form|打开了浏览器|点击了|填写了表单)\b/iu.test(
      request.response,
    );
  const claimsVision =
    /\b(?:I (?:analyzed|inspected) (?:the )?(?:image|screenshot|photo)|vision (?:shows|analysis)|screenshot (?:shows|captured)|截图显示|我分析了图片)\b/iu.test(
      request.response,
    );

  if (claimsBrowserAction && !usedBrowser) {
    return {
      ok: false,
      reason: 'claimed browser action without browser tools',
      retryLimit: 1,
      correction:
        '[System] You claimed a browser action (click/fill/navigate), but `web_browser_control` / `web_browser_fetch` were not used this turn. ' +
        'Drive the browser tools, use `web_fetch` for static pages, or restate without inventing UI actions.',
    };
  }

  if (claimsVision && !usedVision) {
    return {
      ok: false,
      reason: 'claimed vision/screenshot without vision tools',
      retryLimit: 1,
      correction:
        '[System] You claimed image/screenshot analysis, but `vision_analyze` / `screenshot_capture` were not used this turn. ' +
        'Call those tools, or restate without inventing visual evidence.',
    };
  }

  return { ok: true };
}

/**
 * Soft gate: plan/eval/structured-output honesty for this turn.
 * - Claims plan approved/completed without plan tools.
 * - Claims eval suite passed without eval.
 * - Claims structured JSON emitted without generate_structured.
 */
export function evaluatePlanEvalCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const usedPlan =
    (request.toolCallsByName.plan ?? 0) + (request.toolCallsByName.plan_step ?? 0) > 0;
  const usedEval = (request.toolCallsByName.eval ?? 0) > 0;
  const usedStructured = (request.toolCallsByName.generate_structured ?? 0) > 0;

  // Honest "no formal plan tool / I only outlined in prose" passes.
  if (
    /\b(?:no formal plan|without plan tools?|prose (?:only )?plan|did not (?:use|call) plan|未使用 plan)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsPlanDone =
    /\b(?:plan (?:is )?(?:approved|complete|completed|finished|executed)|all steps (?:are )?(?:done|complete)|execution complete|计划(?:已)?(?:批准|完成|执行完毕)|步骤全部完成)\b/iu.test(
      request.response,
    );
  const claimsEvalPassed =
    /\b(?:eval (?:suite )?(?:passed|all green|complete)|benchmark (?:passed|green)|评测(?:通过|完成)|评估套件通过)\b/iu.test(
      request.response,
    );
  const claimsStructuredReady =
    /\b(?:structured (?:output|json) (?:is )?(?:ready|valid|emitted)|generate_structured (?:succeeded|ok)|结构化输出(?:已)?(?:就绪|有效))\b/iu.test(
      request.response,
    );

  if (claimsPlanDone && !usedPlan) {
    return {
      ok: false,
      reason: 'claimed plan complete without plan tools',
      retryLimit: 1,
      correction:
        '[System] You claimed a plan was approved/completed/executed, but `plan` / `plan_step` were not used this turn. ' +
        'Either drive the formal plan tools, or restate as a **prose outline** without claiming tool-backed plan state. ' +
        'Do not invent plan progress.',
    };
  }

  if (claimsEvalPassed && !usedEval) {
    return {
      ok: false,
      reason: 'claimed eval passed without eval tool',
      retryLimit: 1,
      correction:
        '[System] You claimed an eval/benchmark suite passed, but `eval` was not called this turn. ' +
        'Run `eval` with define/run/report, or restate results only from evidence you actually have. ' +
        'Do not invent eval scores.',
    };
  }

  if (claimsStructuredReady && !usedStructured) {
    return {
      ok: false,
      reason: 'claimed structured output without generate_structured',
      retryLimit: 1,
      correction:
        '[System] You claimed structured JSON was validated/emitted, but `generate_structured` was not called this turn. ' +
        'Call `generate_structured` (or clearly say you only drafted freeform JSON). Do not invent schema validation.',
    };
  }

  return { ok: true };
}

/**
 * Soft gate: do not invent user interview answers.
 * Claims the user chose/approved an option without ask_user_question this turn.
 */
export function evaluateAskUserCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };
  if ((request.toolCallsByName.ask_user_question ?? 0) > 0) return { ok: true };

  // Strong claims that a structured interview already happened.
  const claimsUserChose =
    /\b(?:user (?:chose|selected|picked|approved|confirmed|answered)|you chose|you selected|you picked|according to your (?:choice|selection|answer)|用户(?:选择|选了|确认|回答)了|按你的选择)\b/iu.test(
      request.response,
    );
  if (!claimsUserChose) return { ok: true };

  // Honest "assuming / I will proceed without asking" passes.
  if (
    /\b(?:assuming|I (?:will )?assume|without asking|did not ask|proceeding with|默认假设|未询问|先按)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'claimed user choice without ask_user_question',
    retryLimit: 1,
    correction:
      '[System] You claimed the user chose/approved an option, but `ask_user_question` was not called this turn. ' +
      'Either call `ask_user_question` to collect a real answer, or restate your plan as an **assumption** you are proceeding with. ' +
      'Do not invent interview results.',
  };
}

/**
 * Soft gate: long-term memory honesty for this turn.
 * - Claims stored/saved a memory without memory_write.
 * - Claims deleted a memory without memory_delete.
 */
export function evaluateMemoryCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const wrote = (request.toolCallsByName.memory_write ?? 0) > 0;
  const deleted = (request.toolCallsByName.memory_delete ?? 0) > 0;
  const read = (request.toolCallsByName.memory_read ?? 0) > 0;

  // Honest "I did not store / no write" passes.
  if (
    /\b(?:did not (?:store|save|write|remember)|no memory write|未写入|没有记住|未保存)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  const claimsStored =
    /\b(?:stored in memory|saved (?:to |in )?memory|wrote (?:to )?memory|I (?:have )?remembered|memory_write|已写入记忆|已记住|记在记忆里)\b/iu.test(
      request.response,
    );
  const claimsDeleted =
    /\b(?:deleted (?:the )?memory|removed (?:from )?memory|memory_delete|已删除记忆)\b/iu.test(
      request.response,
    );
  const claimsRecalledAsFact =
    /\b(?:from (?:long[- ]?term )?memory|memory says|I recall from memory|根据记忆|从记忆中)\b/iu.test(
      request.response,
    );

  if (claimsStored && !wrote) {
    return {
      ok: false,
      reason: 'claimed memory write without memory_write',
      retryLimit: 1,
      correction:
        '[System] You claimed to store/save something in long-term memory, but `memory_write` was not called this turn. ' +
        'Call `memory_write` with one durable fact (or clearly say you did not persist it). Do not invent a memory write.',
    };
  }

  if (claimsDeleted && !deleted) {
    return {
      ok: false,
      reason: 'claimed memory delete without memory_delete',
      retryLimit: 1,
      correction:
        '[System] You claimed to delete a memory entry, but `memory_delete` was not called this turn. ' +
        'Call `memory_delete` with the entry id (or clearly say you did not delete it).',
    };
  }

  // Prefer not to block generic "I recall" without tools — only when finishing with a strong memory-source claim.
  if (
    claimsRecalledAsFact &&
    !read &&
    (SUCCESS_CLAIM_RE.test(request.response) ||
      /\b(?:all done|done\.|finished|completed|完成了|搞定)\b/iu.test(request.response))
  ) {
    return {
      ok: false,
      reason: 'claimed memory recall without memory_read',
      retryLimit: 1,
      correction:
        '[System] You attributed the answer to long-term memory (`from memory` / 根据记忆) while finishing, ' +
        'but `memory_read` was not called this turn. Call `memory_read` to retrieve evidence, or restate without claiming a memory source.',
    };
  }

  return { ok: true };
}

/**
 * Soft gate: skill marketplace honesty for this turn.
 * - Installed without load_skill but claims loaded/ready.
 * - Only searched SkillHub but claims installed/loaded (search ≠ install).
 */
export function evaluateSkillLoadCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  if (request.stopReason === 'aborted_by_user') return { ok: true };

  const installs =
    (request.toolCallsByName.skillhub_install ?? 0) +
    (request.toolCallsByName.install_skill ?? 0);
  const searches = request.toolCallsByName.skillhub_search ?? 0;
  const loads = request.toolCallsByName.load_skill ?? 0;

  const claimsSkillLoaded =
    /\b(?:skill\s+(?:is\s+)?(?:loaded|active|ready|installed and ready)|loaded the skill|skill loaded|已加载技能|技能已加载|技能已就绪)\b/iu.test(
      request.response,
    ) ||
    // "…skill … is ready" / "…skill and it is ready"
    /\bskill\b[\s\S]{0,40}\b(?:is\s+)?ready\b/iu.test(request.response);
  const claimsInstallTaskDone =
    (/\b(?:skill\s+(?:is\s+)?installed|installed the skill|skill installed|安装(?:完成|好了)|已安装技能)\b/iu.test(
      request.response,
    ) ||
      /\bI installed (?:the |a )?\w* ?skill\b/iu.test(request.response) ||
      /\binstalled (?:the |a )?(?:\w+ )?skill\b/iu.test(request.response)) &&
    (SUCCESS_CLAIM_RE.test(request.response) ||
      claimsSkillLoaded ||
      /\b(?:all done|done\.|finished|completed|完成了|搞定|ready)\b/iu.test(request.response));

  // Honest "for later / did not load / only searched" passes.
  if (
    /\b(?:for future|later sessions?|next time|only installed|did not load|only searched|search only|未加载|仅安装|仅搜索|下次再用)\b/iu.test(
      request.response,
    )
  ) {
    return { ok: true };
  }

  // Search-only: claim installed/loaded without install or load tools.
  if (
    searches > 0 &&
    installs === 0 &&
    loads === 0 &&
    (claimsSkillLoaded || claimsInstallTaskDone)
  ) {
    return {
      ok: false,
      reason: 'skillhub search without install or load',
      retryLimit: 1,
      correction:
        '[System] You only ran `skillhub_search` this turn, but claimed a skill is installed or loaded. ' +
        'Search returns catalog hits only. Call `skillhub_install` then `load_skill` (or `load_skill` if the skill is already local), ' +
        'or clearly say you only searched. Do not invent an install/load that did not run.',
    };
  }

  if (installs === 0) return { ok: true };
  if (loads > 0) return { ok: true };

  if (!claimsSkillLoaded && !claimsInstallTaskDone) return { ok: true };

  return {
    ok: false,
    reason: 'skill installed without load_skill',
    retryLimit: 1,
    correction:
      '[System] You ran `skillhub_install` / `install_skill` but never called `load_skill` this turn. ' +
      'Install only writes SKILL.md to the workspace — it does **not** inject instructions for the current turn. ' +
      'Call `load_skill` with the skill name/slug and follow its body, or clearly state you only installed it for future sessions. ' +
      'Do not claim the skill is loaded/active for this task until `load_skill` has run.',
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
    if (
      r.name !== 'fan_out_subagents' &&
      r.name !== 'create_subagent' &&
      r.name !== 'subagent_status'
    ) {
      return false;
    }
    // Non-terminal status is not a finish failure.
    if (r.name === 'subagent_status' && /\]\s*(RUNNING|PENDING|STARTED)\b/i.test(r.text)) {
      return false;
    }
    if (r.isError) return true;
    if (/Error:\s*\[fan_out_subagents\]/i.test(r.text)) return true;
    if (/Error:\s*\[Sub-agent/i.test(r.text)) return true;
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
      '[System] A recent `fan_out_subagents` / `create_subagent` / `subagent_status` result has FAILED or empty children, ' +
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
      evaluateRunningBackgroundSubagentGate(request),
      evaluateVerificationOutcomeGate(request),
      evaluateFailureDrivenGate(request),
      evaluateFanOutMergeGate(request),
      evaluateSkillLoadCompletionGate(request),
      evaluateMemoryCompletionGate(request),
      evaluateAskUserCompletionGate(request),
      evaluatePlanEvalCompletionGate(request),
      evaluateBrowserVisionCompletionGate(request),
      evaluateDeviceCompletionGate(request),
      evaluateWebToolsCompletionGate(request),
      evaluateInventedVerificationCompletionGate(request),
      evaluateInventedEditCompletionGate(request),
      evaluateInventedGitCompletionGate(request),
      evaluateInventedInstallCompletionGate(request),
      evaluateInventedCodegraphCompletionGate(request),
      evaluateInventedDockerCompletionGate(request),
      evaluateInventedBackgroundServerCompletionGate(request),
      evaluateInventedPublishDeployCompletionGate(request),
      evaluateInventedFormatCompletionGate(request),
      evaluateInventedMigrateCompletionGate(request),
      evaluateInventedCodegenCompletionGate(request),
      evaluateInventedSeedCompletionGate(request),
      evaluateInventedE2eCompletionGate(request),
      evaluateInventedCoverageCompletionGate(request),
      evaluateInventedSnapshotCompletionGate(request),
      evaluateInventedAuditCompletionGate(request),
      evaluateInventedSmokeLoadCompletionGate(request),
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
