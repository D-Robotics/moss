/**
 * Coding verification + incomplete-todo completion gate (CLI host).
 *
 * Chain (first failure wins):
 * 1) Incomplete multi-item todo_write checklist (Grok TodoGate light, retryLimit 2)
 * 2) Edited code under fix/implement intent without real verification evidence
 * 3) Latest verification result is red while the model claims success
 * 4) Recent tool failure ignored under a done/success claim
 * 5) Fix/bug intent with edits but zero investigation tools (debug soft nudge)
 *
 * Soft: low retryLimit, clear coding / multi-step intents only.
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

const SKIP_TESTS_USER_RE =
  /(?:不要跑测试|跳过测试|skip\s+tests?|no\s+tests?|only\s+(?:docs?|copy|文案)|只改文案|docs?\s+only|documentation\s+only)/iu;

const TODO_LINE_RE = /^\s*\d+\.\s+[○◐✓]\s+(.+?)\s+\[(pending|in_progress|completed)\]\s*$/gm;

/** Command strings that count as verification when run via exec. */
const VERIFY_COMMAND_RE =
  /(?:\b(?:test|tests|verify|typecheck|lint|build|jest|vitest|pytest|mocha)\b|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npm\s+run\s+(?:test|verify|check|lint|build|typecheck)|pnpm\s+run\s+(?:test|verify|check|lint|build|typecheck)|yarn\s+(?:test|run\s+(?:test|verify|check|lint|build|typecheck))|\bnpx\s+tsc\b|\btsc\b)/i;

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

/**
 * True when the run has real verification evidence: dedicated tools, or exec
 * whose command matches a test/build/typecheck/lint pattern.
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

  // Fallback: scan tool_use blocks even if counts omitted exec name variants
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

interface NamedToolResult {
  name: string;
  text: string;
  isVerification: boolean;
  /** Explicit tool failure flags from the agent loop (is_error / outcome). */
  isError: boolean;
  outcome?: string;
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

      let isVerification = VERIFY_TOOLS.has(name);
      if (!isVerification && EXEC_TOOLS.has(name)) {
        const cmd = useId ? execById.get(useId) : undefined;
        isVerification = Boolean(cmd && isVerificationCommand(cmd));
      }

      out.push({
        name: name || 'unknown',
        text: text || (flaggedError ? `Error: tool ${b.outcome || 'error'}` : ''),
        isVerification,
        isError: flaggedError,
        outcome: b.outcome,
      });
    }
  }
  return out;
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
 * Soft gate: edits under coding-change intent require real verification evidence
 * (dedicated tools or exec with a test/build/typecheck/lint command).
 */
export function evaluateCodingCompletionGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  if (hasVerificationEvidence(request.messages, request.toolCallsByName)) {
    return { ok: true };
  }

  const userText = lastUserText(request.messages);
  if (!userText || !CODING_CHANGE_RE.test(userText)) return { ok: true };

  if (SKIP_TESTS_USER_RE.test(userText)) return { ok: true };

  if (/\b(?:did not|didn't|no)\s+(?:run\s+)?tests?\b|未运行测试|没有跑测试/iu.test(request.response)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'edited code without verification',
    retryLimit: 1,
    correction:
      '[System] You edited code but did not run real verification. Before finishing: ' +
      'call `run_tests` or `verify_fix` (preferred), or `exec` with a clear test/build/typecheck command ' +
      '(e.g. `npm test`, `npm run verify`, `tsc`). Arbitrary shell (e.g. `echo`) does not count. ' +
      'See the real output, then report done with that evidence. Do not claim the change works without running it.',
  };
}

/**
 * Soft gate: latest verification tool result is red while the model claims success.
 */
export function evaluateVerificationOutcomeGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const results = collectNamedToolResults(request.messages).filter((r) => r.isVerification);
  if (results.length === 0) return { ok: true };

  const latest = results[results.length - 1]!;
  if (!isVerificationResultFailure(latest.text, latest.isError)) return { ok: true };

  if (ADMITS_FAILURE_RE.test(request.response)) return { ok: true };
  if (!SUCCESS_CLAIM_RE.test(request.response)) return { ok: true };

  const preview = failurePreview(latest.text);

  return {
    ok: false,
    reason: 'verification failed but success claimed',
    retryLimit: 1,
    correction:
      '[System] The latest verification result shows failure, but your reply claims success. ' +
      'Do not report done as green while verification is red.\n' +
      `Latest ${latest.name} output (excerpt):\n${preview}\n` +
      'Fix the failures and re-run verification, or report the failure honestly with evidence.',
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
 * Soft gate: fix/bug intent + edits with zero investigation tools in the run.
 * Claude/Codex discipline — reproduce / locate before patching.
 */
export function evaluateDebugInvestigationGate(
  request: CodingCompletionGateRequest,
): CodingCompletionGateResult {
  const edits = countByPrefix(request.toolCallsByName, EDIT_TOOLS);
  if (edits === 0) return { ok: true };

  if (countByPrefix(request.toolCallsByName, INVESTIGATE_TOOLS) > 0) return { ok: true };

  const userText = lastUserText(request.messages);
  if (!userText || !DEBUG_FIX_INTENT_RE.test(userText)) return { ok: true };

  // User already said the fix is known / one-liner — don't thrash.
  if (
    /(?:known fix|one[- ]?line|trivial|just change|直接改|已知修复|一行)/iu.test(userText) ||
    /(?:known fix|one[- ]?line|trivial|just change|直接改|已知修复|一行)/iu.test(request.response)
  ) {
    return { ok: true };
  }

  // Model already described investigation evidence in the reply — soft pass.
  if (
    /\b(?:read|searched|reproduced|stack trace|error was|根因|复现|定位)\b/iu.test(request.response)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'edited without investigation',
    retryLimit: 1,
    correction:
      '[System] You edited code for a fix/bug request without any investigation tools ' +
      '(`read_file`, `search_code`, `exec` to reproduce, `run_tests`, …). ' +
      'Before finishing: locate or reproduce the issue (read/search/run), then apply a minimal fix, ' +
      'or explicitly state this is a known one-line fix with the evidence you already have. ' +
      'Do not blind-patch and report done.',
  };
}

/**
 * Compose host completion gates: structured-output is handled inside MossAgent
 * before this runs. Chain todo → coding evidence → outcome → failure-driven →
 * debug investigation → extra.
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
      evaluateVerificationOutcomeGate(request),
      evaluateFailureDrivenGate(request),
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
