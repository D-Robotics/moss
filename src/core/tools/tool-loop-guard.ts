import { stableSerializeToolInput } from './tool-idempotent-replay.js';
import { readEnv } from '../../utils/env-compat.js';
import path from 'node:path';
import { canonicalPath, findProtectedWrite } from '../../safety/shell-write-detect.js';

const SINGLE_TOOL_LIMIT_EXEMPT_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'move_file',
  'apply_patch',
  'list_directory',
  'search_files',
  'search_code',
  'device_file_read',
  'device_file_list',
]);

/** Discovery tools: repeated *failures* should stop sooner than generic tools. */
const DISCOVERY_TOOLS = new Set([
  'list_directory',
  'search_files',
  'search_code',
  'read_file',
  'device_file_list',
  'device_file_read',
  // CodeGraph navigation thrash (same failed hop / empty node spam).
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_trace',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_context',
  'codegraph_explore',
  'codegraph_files',
  'codegraph_status',
  // Skill catalog / load / install thrash.
  'skillhub_search',
  'skillhub_install',
  'install_skill',
  'load_skill',
  // Sub-agent spawn/status thrash (repeated failed fan-out / create / status).
  'create_subagent',
  'fan_out_subagents',
  'subagent_status',
  'subagent_stop',
  // Long-term memory thrash.
  'memory_read',
  'memory_write',
  'memory_delete',
  // Structured user interview thrash.
  'ask_user_question',
  // Plan / eval / structured-output thrash.
  'plan',
  'plan_step',
  'eval',
  'generate_structured',
  // Browser control thrash.
  'web_browser_fetch',
  'web_browser_control',
  // Vision / screenshot thrash.
  'vision_analyze',
  'screenshot_capture',
  // Device / fleet thrash (beyond file list/read already covered).
  'device_exec',
  'device_info',
  'device_temperature',
  'device_resources',
  'device_processes',
  'device_network',
  'device_cameras',
  'device_robotics_status',
  'fleet_batch',
]);

const DEFAULT_IDENTICAL_TOOL_INPUT_LIMIT = 3;
const DEFAULT_TOOL_FAILURE_LIMIT = 3;
/** Failed discovery retries on the same tool before short-circuit (stricter than generic 3). */
const DEFAULT_DISCOVERY_FAILURE_LIMIT = 2;

// Default 6 — headroom for a few genuinely different search angles (a Chinese
// query, an English query, the brand name, a refined keyword set) before
// blocking the 7th. The old cap of 4 was too tight: with the keyless backend
// often returning degraded results the model legitimately needs more than one
// refinement, and a 4-query cap drove it into guessing URLs instead. Override
// via MOSS_WEB_SEARCH_VARIATION_LIMIT.
const DEFAULT_WEB_SEARCH_VARIATION_LIMIT = 6;

/** Surgical edit tools that thrash when old_string / patch body is stale. */
const SURGICAL_EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'apply_patch']);

/** Max failed surgical edits per path before forcing re-read (identical input limit still applies). */
const DEFAULT_EDIT_PATH_FAILURE_LIMIT = 3;

/**
 * O96: exec / run_tests that finish normally with a non-zero exit (lint/test fail)
 * must not burn the global byToolFailure budget. Same-command identical-output
 * thrash still hints to change approach via a separate counter.
 */
const VERIFY_SHELL_TOOLS = new Set(['exec', 'run_tests']);
/** Consecutive same-command failures with identical output before hinting to change approach. */
const DEFAULT_SAME_COMMAND_FAILURE_LIMIT = 3;

export type ShellFaultKind = 'timeout' | 'start_failure' | 'killed' | 'unusable';

export type SameCommandFailureStreak = {
  count: number;
  outputKey: string;
  displayCommand: string;
};

export type ToolLoopGuardState = {
  bySignature: Map<string, number>;
  byTool: Map<string, number>;
  byToolFailure: Map<string, number>;
  // Per-URL failure count for web_fetch. web_fetch targets are independent
  // (different hosts fail for different reasons — a 401 on Reuters says
  // nothing about whether IEEE's RSS is fetchable), so a tool-level failure
  // cap would punish legitimate source-switching. Only a *single URL*
  // failing repeatedly counts toward blocking that URL.
  byWebFetchUrlFailure: Map<string, number>;
  /**
   * Per-file surgical-edit failures (edit_file / multi_edit). Prevents
   * thrashing the same path with slightly different old_string after reads
   * go stale — Claude Code "read then edit" discipline at the loop layer.
   */
  byEditPathFailure: Map<string, number>;
  /**
   * O96: per normalized command signature — consecutive normal non-zero exits
   * with substantially identical output. Does not feed byToolFailure.
   */
  bySameCommandFailure: Map<string, SameCommandFailureStreak>;
  /** O96: last real shell fault kind for exec/run_tests (timeout / start / …). */
  lastShellFaultKind: Map<string, ShellFaultKind>;
  /**
   * O96: missing command name parsed from a 126/127 start failure's output.
   * Copy-only — never used for classification.
   */
  lastMissingCommand?: Map<string, string>;
  /**
   * O97: paths whose edit/write was just refused for read scope (partial
   * window, file content not attached). While locked, an exec that would write
   * the same file is blocked too, so the model cannot route around the edit
   * tool with `node -e` / `sed -i` / redirects. Cleared by a full read_file of
   * the path or a successful edit/write to it.
   */
  readScopeLockedPaths: Set<string>;
  /** O97: thrash counter key → path as the model wrote it (for realpath compare). */
  editPathRaw?: Map<string, string>;
  /** Workspace the run's tools resolve relative paths against. */
  workspaceDir?: string;

  webSearchQueries: Set<string>;
  freshNewsSearchRequested: boolean;
  hasSufficientRssNewsEvidence: boolean;
  total: number;
};

function resolveOptionalPositiveIntEnv(name: string, fallback?: number): number | undefined {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === '0' ||
    normalized === 'off' ||
    normalized === 'false' ||
    normalized === 'disabled'
  ) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePathKey(raw: string): string {
  return raw.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * All workspace paths touched by a surgical edit call. multi_edit / apply_patch
 * can touch many files — thrash must count every path, not only the first.
 * @internal exported for tests
 */
export function collectSurgicalEditPathKeys(input?: Record<string, unknown>): string[] {
  if (!input || typeof input !== 'object') return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const k = normalizePathKey(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  };

  // edit_file / write-style single path
  if (typeof input.path === 'string' && input.path.trim()) {
    add(input.path);
  }

  // multi_edit: every edits[].path
  if (Array.isArray(input.edits)) {
    for (const item of input.edits) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { path?: unknown }).path === 'string'
      ) {
        add(String((item as { path: string }).path));
      }
    }
  }

  // apply_patch: every Update/Delete/Add File line
  if (typeof input.patch === 'string' && input.patch.trim()) {
    const re = /\*\*\*\s+(?:Update|Delete|Add)\s+File:\s*(\S+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.patch)) !== null) {
      if (m[1]) add(m[1]);
    }
    if (keys.length === 0) {
      // Unparseable patch body — stable fallback so identical resubmits still count
      add(`patch:${input.patch.length}:${input.patch.slice(0, 64)}`);
    }
  }

  return keys;
}

/** Edit/write tools whose read-scope refusal locks the path for shell writes too. */
const FILE_MUTATION_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'apply_patch',
  'write_file',
  'move_file',
]);

const SHELL_TOOLS = new Set(['exec', 'exec_background', 'bash']);

function rawMutationPaths(toolName: string, input?: Record<string, unknown>): string[] {
  if (!input) return [];
  const out: string[] = [];
  if (typeof input.path === 'string' && input.path.trim()) out.push(input.path);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const p = (e as { path?: unknown } | null)?.path;
      if (typeof p === 'string' && p.trim()) out.push(p);
    }
  }
  if (typeof input.patch === 'string') {
    for (const m of input.patch.matchAll(/\*\*\*\s+(?:Update|Delete|Add)\s+File:\s*(\S+)/gi)) {
      if (m[1]) out.push(m[1]);
    }
  }
  if (toolName === 'move_file' && typeof input.destination === 'string')
    out.push(input.destination);
  return out;
}

function lockKey(state: ToolLoopGuardState, raw: string): string {
  return canonicalPath(path.resolve(state.workspaceDir ?? process.cwd(), raw));
}

function trackReadScopeLocks(
  state: ToolLoopGuardState,
  toolName: string,
  isError: boolean,
  resultText: string | undefined,
  input: Record<string, unknown> | undefined
): void {
  const locks = state.readScopeLockedPaths;
  if (!locks) return;
  if (toolName === 'read_file') {
    const full = input && input.offset === undefined && input.limit === undefined;
    if (full && !isError && typeof input?.path === 'string') {
      locks.delete(lockKey(state, input.path));
    }
    return;
  }
  if (!FILE_MUTATION_TOOLS.has(toolName)) return;
  const text = resultText ?? '';
  const refused = /You only read a partial window of /.test(text);
  for (const raw of rawMutationPaths(toolName, input)) {
    const key = lockKey(state, raw);
    // Remember the real path behind the (lower-cased) thrash counter key.
    state.editPathRaw?.set(normalizePathKey(raw), raw);
    if (refused && !text.includes('[full file: ')) locks.add(key);
    else if (!isError && !refused) locks.delete(key);
  }
}

export function createToolLoopGuardState(
  options: { workspaceDir?: string } = {}
): ToolLoopGuardState {
  return {
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    editPathRaw: new Map(),
    bySignature: new Map(),
    byTool: new Map(),
    byToolFailure: new Map(),
    byWebFetchUrlFailure: new Map(),
    byEditPathFailure: new Map(),
    bySameCommandFailure: new Map(),
    lastShellFaultKind: new Map(),
    lastMissingCommand: new Map(),
    readScopeLockedPaths: new Set(),
    webSearchQueries: new Set(),
    freshNewsSearchRequested: false,
    hasSufficientRssNewsEvidence: false,
    total: 0,
  };
}

// Normalize a web_fetch URL to a stable key for per-URL failure counting.
// Strips the fragment and a trailing slash so trivial variations (a `#section`
// anchor, a cosmetic trailing slash) don't let the model reset the counter on
// what is effectively the same fetch. Query string is kept — different query
// strings can be genuinely different resources. Returns null if the input has
// no usable URL (empty, wrong type, or unparseable), in which case callers
// fall back to tool-level tracking rather than silently dropping the signal.
function normalizeWebFetchUrlKey(input: unknown): string | null {
  const raw =
    typeof input === 'object' && input !== null
      ? String((input as Record<string, unknown>)?.url ?? '').trim()
      : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    const key = `${url.origin}${url.pathname}${url.search}`.replace(/\/$/, '') || url.origin;
    return key || null;
  } catch {
    // Not a valid absolute URL — key on the raw string so repeated identical
    // garbage still counts, but distinct garbage strings don't collide.
    return raw;
  }
}

/**
 * O96: normalize exec / run_tests command for same-command streak keys.
 * @internal exported for tests
 */
export function normalizeVerifyCommandSignature(
  toolName: string,
  input?: Record<string, unknown>
): { key: string; display: string } | null {
  if (toolName === 'exec') {
    const cmd = typeof input?.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : '';
    if (!cmd) return null;
    return { key: `exec:${cmd.toLowerCase()}`, display: cmd };
  }
  if (toolName === 'run_tests') {
    const file = typeof input?.file === 'string' && input.file.trim() ? input.file.trim() : '';
    const cmd =
      typeof input?.command === 'string' && input.command.trim() ? input.command.trim() : '';
    const display = file ? `node --test ${file}` : cmd || 'npm test';
    return { key: `run_tests:${display.toLowerCase().replace(/\s+/g, ' ')}`, display };
  }
  return null;
}

/** @internal exported for tests */
export function normalizeShellOutputFingerprint(resultText: string): string {
  return resultText
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * O96: classify an exec / run_tests error result.
 * - `normal_nonzero`: process started and finished; lint/test simply failed.
 * - fault kinds: timeout / start failure / killed / unusable empty output.
 * - `other`: policy deny, blocked, or unrecognized — keep existing byToolFailure path.
 * @internal exported for tests
 */
export function classifyShellToolFailure(
  resultText: string | undefined
): 'normal_nonzero' | ShellFaultKind | 'other' {
  const text = resultText ?? '';
  const head = text.slice(0, 600);
  // Fault markers are only trusted on the tool-generated first line. Child
  // stdout (e.g. a test named "... timed out after 5000ms") must never be
  // scanned for fault text, or a normal run is misclassified as a tool fault.
  const firstLine = (head.replace(/^\s+/, '').split(/\r?\n/, 1)[0] ?? '').trim();

  // Normal completion header: process ran to completion; stdout is untrusted.
  const exitHeader = /^exit_code:\s*(\d+)\b/i.exec(firstLine);
  // 126 (not executable) / 127 (command not found) from the exec first line
  // mean the process never started — a tool fault, not a lint/test failure.
  if (exitHeader) {
    const code = Number(exitHeader[1]);
    if (code === 126 || code === 127) return 'start_failure';
    return code > 0 ? 'normal_nonzero' : 'other';
  }
  if (/^Command failed \(exit\s+12[67]\)/i.test(firstLine)) return 'start_failure';
  if (/^Command failed \(exit\s+[1-9]\d*\)/i.test(firstLine)) return 'normal_nonzero';

  if (
    /^timed out after\b/i.test(firstLine) ||
    /^❌\s*timed out\b/i.test(firstLine) ||
    /^Execution error:.*\btimed out\b/i.test(firstLine) ||
    /^Tool \S+ timed out\b/i.test(firstLine)
  ) {
    return 'timeout';
  }
  if (/^Command killed by\b/i.test(firstLine)) {
    return 'killed';
  }
  // "Command failed:" without "(exit N)" — spawn/start failure style from builtin.ts
  if (/^Command failed:\s*$/i.test(firstLine)) {
    return 'start_failure';
  }
  if (
    /^(?:Execution error:|Error:)?.*\bspawn(?:Sync)?\b.*\bENOENT\b/i.test(firstLine) ||
    /^(?:Execution error:|Error:)\s.*\bENOENT\b/i.test(firstLine) ||
    /^(?:\S+:\s*)?(?:\S+:\s*)?command not found\b/i.test(firstLine) ||
    /^.*\bnot found in PATH\b/i.test(firstLine) ||
    /^(?:Error:\s*)?Failed to (?:start|launch|spawn)\b/i.test(firstLine) ||
    /^未能启动/.test(firstLine)
  ) {
    return 'start_failure';
  }
  if (/^Execution error:/i.test(firstLine)) {
    return 'start_failure';
  }

  // Policy / user deny — not a normal lint non-zero (QA guardrail).
  if (
    /^\s*Command blocked:/i.test(head) ||
    /^\s*已拦截/u.test(head) ||
    /^\s*Blocked\b/i.test(head) ||
    /^\s*Tool execution denied\b/i.test(head) ||
    /^\s*Operation blocked by workspace policy\b/i.test(head)
  ) {
    return 'other';
  }

  // Normal completed non-zero (lint / test / check failed).
  if (/Test Results:\s*❌\s+\d+\s+FAILED\b/i.test(head)) return 'normal_nonzero';
  if (/Test Results:\s*❌\s+exit\s+[1-9]/i.test(head)) return 'normal_nonzero';
  if (/Test Results:\s*⚠️\s*NO TESTS EXECUTED/i.test(head)) return 'normal_nonzero';
  if (/Verify Fix:\s*❌/i.test(head)) return 'normal_nonzero';
  if (/❌\s+\d+\s+FAILED\b/i.test(head)) return 'normal_nonzero';

  const trimmed = text.trim();
  if (!trimmed || trimmed === '(no output)') {
    return 'unusable';
  }
  return 'other';
}

/**
 * O96: best-effort missing command name from shell "not found" output
 * (`sh: eslint: not found`, `sh: 1: eslint: not found`,
 * `bash: foo: command not found`, `zsh: command not found: foo`,
 * `bash: /no/such/bin: No such file or directory`). Copy-only.
 * @internal exported for tests
 */
export function parseMissingCommandName(resultText: string | undefined): string | undefined {
  const text = (resultText ?? '').slice(0, 4000);
  const patterns = [
    /^(?:\S*\/)?(?:sh|bash|dash|ash|ksh)(?::\s*(?:line\s+)?\d+)?:\s*([^\s:]+):\s*(?:command\s+)?not found\b/im,
    /^(?:\S*\/)?zsh(?::\d+)?:\s*command not found:\s*(\S+)/im,
    /^(?:\S*\/)?(?:sh|bash|dash|ash|ksh)(?::\s*(?:line\s+)?\d+)?:\s*(\/[^\s:]+):\s*No such file or directory\b/im,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const name = m?.[1];
    // Display-only: strict whitelist, else fall back to generic copy.
    if (name && /^[A-Za-z0-9._/-]{1,64}$/.test(name)) return name;
    if (name) return undefined;
  }
  return undefined;
}

export function isSoftToolFailureResult(resultText: string | undefined): boolean {
  if (!resultText) return false;
  if (/^\s*(web_fetch_error|web_search_error)\b/i.test(resultText)) return true;
  if (/^\s*\S+\s+blocked automated access/i.test(resultText)) return true;

  const head = resultText.split(/\r?\n/).slice(0, 16).join('\n');
  if (!/^\s*source:\s+\S+/im.test(head)) return false;
  return (
    /^\s*http_ok:\s+false\b/im.test(head) ||
    /^\s*fetch_warning:\s+HTTP\s+(?:4\d\d|5\d\d)\b/im.test(head)
  );
}

export function recordToolLoopOutcome(
  state: ToolLoopGuardState,
  toolName: string,
  isError: boolean,
  resultText?: string,
  input?: Record<string, unknown>
): void {
  if (
    toolName === 'web_search' &&
    !isError &&
    /RSS news snapshot: dated publisher\/feed summaries above are sufficient/i.test(
      resultText ?? ''
    )
  ) {
    state.hasSufficientRssNewsEvidence = true;
  }
  trackReadScopeLocks(state, toolName, isError, resultText, input);
  if (!isError && !isSoftToolFailureResult(resultText)) {
    // O96: trust is_error only (set by execute-tool-call anchored
    // isStringToolFailureResult). Never text-scan successful output.
    if (VERIFY_SHELL_TOOLS.has(toolName)) {
      const sig = normalizeVerifyCommandSignature(toolName, input);
      if (sig) state.bySameCommandFailure.delete(sig.key);
    }
    return;
  }
  // O96: normal completed non-zero for exec/run_tests — independent streak only.
  if (VERIFY_SHELL_TOOLS.has(toolName)) {
    const kind = classifyShellToolFailure(resultText);
    if (kind === 'normal_nonzero') {
      const sig = normalizeVerifyCommandSignature(toolName, input);
      if (sig) {
        const outputKey = normalizeShellOutputFingerprint(resultText ?? '');
        const prev = state.bySameCommandFailure.get(sig.key);
        if (prev && prev.outputKey === outputKey) {
          state.bySameCommandFailure.set(sig.key, {
            count: prev.count + 1,
            outputKey,
            displayCommand: sig.display,
          });
        } else {
          state.bySameCommandFailure.set(sig.key, {
            count: 1,
            outputKey,
            displayCommand: sig.display,
          });
        }
      }
      // Do not bump byToolFailure — lint/test non-zero is not a broken tool.
      return;
    }
    if (
      kind === 'timeout' ||
      kind === 'start_failure' ||
      kind === 'killed' ||
      kind === 'unusable'
    ) {
      state.lastShellFaultKind.set(toolName, kind);
      const missing = kind === 'start_failure' ? parseMissingCommandName(resultText) : undefined;
      state.lastMissingCommand ??= new Map();
      if (missing) state.lastMissingCommand.set(toolName, missing);
      else state.lastMissingCommand.delete(toolName);
      const sig = normalizeVerifyCommandSignature(toolName, input);
      if (sig) state.bySameCommandFailure.delete(sig.key);
    }
    // Policy deny / other: fall through to byToolFailure (existing path).
  }
  // web_fetch failures are tracked per-URL (see ToolLoopGuardState) so that a
  // failed host doesn't poison the tool's reputation for unrelated hosts.
  if (toolName === 'web_fetch') {
    const url = normalizeWebFetchUrlKey(input);
    if (url) {
      state.byWebFetchUrlFailure.set(url, (state.byWebFetchUrlFailure.get(url) ?? 0) + 1);
      return;
    }
    // No URL to key on (shouldn't happen for web_fetch) — fall through to the
    // generic tool-level counter rather than silently dropping the signal.
  }
  // Surgical edit thrash: count EVERY path only (like web_fetch per-URL).
  // multi_edit / apply_patch may touch several files — all must accumulate.
  // Do NOT also bump tool-level failure — that would block edits on other
  // files after three thrashing retries on one path.
  if (SURGICAL_EDIT_TOOLS.has(toolName)) {
    const pathKeys = collectSurgicalEditPathKeys(input);
    if (pathKeys.length > 0) {
      for (const pathKey of pathKeys) {
        state.byEditPathFailure.set(pathKey, (state.byEditPathFailure.get(pathKey) ?? 0) + 1);
      }
      return;
    }
  }
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
}

export function formatToolLoopGuardMessage(reason: string, toolName: string): string {
  // O96: same-command identical-output streak — never say STOP / tool broken.
  if (/^same check failed repeatedly/i.test(reason)) {
    const cmd =
      reason.replace(/^same check failed repeatedly\s*\(\d+×\):\s*/i, '').trim() || toolName;
    return [
      `同一检查连续失败：\`${cmd}\` 输出实质相同。请改代码或改命令/断言，不要原样重跑。`,
      `Same check failed repeatedly for \`${cmd}\` with substantially identical output. Change the code or the command/assertions — do not re-run the same check unchanged.`,
      '优先修代码；不要换工具绕开同一检查。Prefer fixing the code; do not switch tools merely to bypass the same check.',
    ].join(' ');
  }
  // O96: real exec/run_tests faults — say 超时 / 未能启动, not "test failed".
  if (VERIFY_SHELL_TOOLS.has(toolName)) {
    if (/timed out \d+ time/i.test(reason)) {
      return [
        `已拦截：${toolName} 连续超时（${reason}）。`,
        `Blocked: ${toolName} timed out repeatedly (${reason}).`,
        '请提高 timeout_ms、简化命令，或改用 exec_background；不要原样重试。',
        'Raise timeout_ms, simplify the command, or use exec_background — do not retry unchanged.',
      ].join(' ');
    }
    const missingMatch = /\(missing command: ([^\s)]+)\)/.exec(reason);
    if (/failed to start \d+ time/i.test(reason) && missingMatch) {
      const name = missingMatch[1];
      return [
        `已拦截：${toolName} 未能启动：找不到命令 \`${name}\`（${reason}）。`,
        `Blocked: ${toolName} failed to start: command \`${name}\` not found (${reason}).`,
        `下一步：装依赖或改命令（例如安装提供 \`${name}\` 的包，或换成已安装的命令）；不要原样重试。`,
        `Next step: install the dependency or change the command (e.g. install the package that provides \`${name}\`, or use a command that is installed) — do not retry unchanged.`,
      ].join(' ');
    }
    if (/failed to start \d+ time/i.test(reason)) {
      return [
        `已拦截：${toolName} 未能启动（命令不存在或起不来；${reason}）。`,
        `Blocked: ${toolName} failed to start (command missing or could not launch; ${reason}).`,
        '请检查命令是否在 PATH 中、拼写是否正确，再换一条能启动的命令。',
        'Check PATH and spelling, then try a command that can actually launch.',
      ].join(' ');
    }
    if (/was killed \d+ time/i.test(reason)) {
      return [
        `已拦截：${toolName} 连续被信号杀掉（${reason}）。`,
        `Blocked: ${toolName} was killed repeatedly (${reason}).`,
        '请检查是否超时杀进程或外部信号；不要原样重试。',
        'Check for timeout kills or external signals — do not retry unchanged.',
      ].join(' ');
    }
    if (/returned unusable results \d+ time/i.test(reason)) {
      return [
        `已拦截：${toolName} 连续返回不可用输出（${reason}）。`,
        `Blocked: ${toolName} returned unusable output repeatedly (${reason}).`,
        '请换一条能产生可读输出的命令；不要原样重试。',
        'Try a different command that produces readable output — do not retry unchanged.',
      ].join(' ');
    }
  }
  if (/fresh-news search is already in progress/i.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'Wait for and use the first result instead of launching parallel language or keyword variants.',
      'If that result is empty, a later assistant step may try one refined query.',
    ].join(' ');
  }
  if (/dated RSS news snapshot/i.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'The current turn already has dated headlines, publisher names, source URLs, and summaries.',
      'Answer now using that evidence; do not broaden the search merely to restate the same news.',
      'Only continue with a known original publisher page when the user explicitly requested full-text verification of a specific claim.',
    ].join(' ');
  }
  // Per-URL web_fetch failure: only this *specific URL* is stuck, not the
  // whole tool. Tell the model to drop this URL and keep going elsewhere —
  // the opposite of the tool-level failure message below.
  if (/^web_fetch on .+ has failed \d+ time/.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'This specific URL is not returning usable results — STOP retrying THIS URL.',
      'Other URLs are still fine: you may web_fetch a different source, or answer with the evidence already gathered.',
      'Never invent, assume, or describe the content you could not actually fetch.',
    ].join(' ');
  }
  if (/^shell write to edit-locked file /.test(reason)) {
    const file = reason.slice('shell write to edit-locked file '.length);
    return [
      `已拦截 / Blocked: ${toolName} would write ${file}, which the edit tools just refused (read scope or repeated failed edits).`,
      'Writing it through the shell (node -e, python -c, sed -i, redirects, tee, cp/mv) is not allowed while it is locked.',
      `Next: call read_file on ${file} without offset/limit, then use edit_file/multi_edit with exact current text.`,
    ].join(' ');
  }
  if (/^edit thrash on /.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'This path has already rejected repeated surgical edits/patches.',
      'STOP retrying edit_file/multi_edit/apply_patch with the same body.',
      'Call `read_file` on that path, rebuild the edit from exact current text, then retry — or switch approach (smaller context, replace_all only when intentional).',
    ].join(' ');
  }
  // Discovery / skill / sub-agent thrash: same input again.
  if (/identical input was already requested/i.test(reason)) {
    if (
      toolName === 'skillhub_search' ||
      toolName === 'skillhub_install' ||
      toolName === 'install_skill' ||
      toolName === 'load_skill'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that skill catalog/install/load result this turn — do not repeat the same query/slug/name.',
        'Next: change slug/keywords, `load_skill` after a successful install, or answer from results already returned.',
        'Never invent install/load outcomes you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'create_subagent' ||
      toolName === 'fan_out_subagents' ||
      toolName === 'subagent_status' ||
      toolName === 'subagent_stop'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that sub-agent call this turn — do not resubmit the same spawn/status/stop input.',
        'Next: change task/scope/label, wait on a different task id, merge evidence you have, or continue without another identical spawn.',
        'Never invent child SUCCESS from repeated failed or duplicate sub-agent calls.',
      ].join(' ');
    }
    if (toolName === 'memory_read' || toolName === 'memory_write' || toolName === 'memory_delete') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that memory result this turn — do not repeat the same query/content/id.',
        'Next: change the query, write a different durable fact, or continue with evidence already retrieved.',
        'Never invent memories you did not observe.',
      ].join(' ');
    }
    if (toolName === 'ask_user_question') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already asked that structured question set this turn — do not resubmit the same interview.',
        'Next: proceed with the answers already collected, ask a *different* clarifying question, or implement against a stated assumption.',
        'Never invent user choices you did not receive.',
      ].join(' ');
    }
    if (
      toolName === 'plan' ||
      toolName === 'plan_step' ||
      toolName === 'eval' ||
      toolName === 'generate_structured'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that plan/eval/structured call this turn — do not resubmit the same payload.',
        'Next: change planId/step/action/schema, continue execution, or answer with results already returned.',
        'Never invent plan progress or eval scores you did not observe.',
      ].join(' ');
    }
    if (toolName === 'web_browser_fetch' || toolName === 'web_browser_control') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that browser call this turn — do not resubmit the same navigation/control payload.',
        'Next: change URL/selector/action, use web_fetch for static pages, or answer from page text already returned.',
        'Never invent browser DOM state you did not observe.',
      ].join(' ');
    }
    if (toolName === 'vision_analyze' || toolName === 'screenshot_capture') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that vision/screenshot call this turn — do not resubmit the same image/target payload.',
        'Next: analyze a different image/region, or answer from vision results already returned.',
        'Never invent image contents you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'device_exec' ||
      toolName === 'device_info' ||
      toolName === 'device_temperature' ||
      toolName === 'device_resources' ||
      toolName === 'device_processes' ||
      toolName === 'device_network' ||
      toolName === 'device_cameras' ||
      toolName === 'device_robotics_status' ||
      toolName === 'fleet_batch'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that device/fleet call this turn — do not resubmit the same command/target payload.',
        'Next: change the command/board/target, or answer from device evidence already returned.',
        'Never invent board state you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'list_directory' ||
      toolName === 'search_code' ||
      toolName === 'search_files' ||
      toolName === 'read_file' ||
      toolName.startsWith('codegraph_')
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that discovery result in this turn — do not re-list or re-search the same target.',
        'Next: open the specific paths you need with `read_file`, refine with a *different* glob/pattern/path, or answer from evidence already gathered.',
        'If stuck, call tool_search group=subagent, then create_subagent scope=explore, instead of repeating the same listing.',
      ].join(' ');
    }
  }
  if (/has failed \d+ time/.test(reason) && !/^web_fetch on /.test(reason)) {
    if (
      toolName === 'skillhub_search' ||
      toolName === 'skillhub_install' ||
      toolName === 'install_skill' ||
      toolName === 'load_skill'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Skill discovery/install/load is failing repeatedly — STOP retrying the same query or skill name/slug.',
        'Change keywords/slug, try a different skill, or continue without that skill using general methods.',
        'Never invent skill bodies or install success you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'create_subagent' ||
      toolName === 'fan_out_subagents' ||
      toolName === 'subagent_status' ||
      toolName === 'subagent_stop'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Sub-agent tools are failing repeatedly — STOP retrying the same spawn/status/stop call.',
        'Change task/scope, reduce fan-out width, fix the underlying error, or continue with parent tools only.',
        'Never invent child SUCCESS after repeated sub-agent failures.',
      ].join(' ');
    }
    if (toolName === 'memory_read' || toolName === 'memory_write' || toolName === 'memory_delete') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Memory tools are failing repeatedly — STOP retrying the same query/content/id.',
        'Change the query, skip writing if the store rejects the content, or continue without that memory.',
        'Never invent stored memories you did not observe.',
      ].join(' ');
    }
    if (toolName === 'ask_user_question') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Structured user questions are failing repeatedly — STOP resubmitting the same ask_user_question payload.',
        'Simplify the questions, proceed with a stated assumption, or ask one freeform question in the reply instead.',
        'Never invent user answers you did not receive.',
      ].join(' ');
    }
    if (
      toolName === 'plan' ||
      toolName === 'plan_step' ||
      toolName === 'eval' ||
      toolName === 'generate_structured'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Plan/eval/structured tools are failing repeatedly — STOP retrying the same action/payload.',
        'Fix planId/schema/suite definition, use a different action, or continue with parent coding tools.',
        'Never invent plan completion or eval results after repeated failures.',
      ].join(' ');
    }
    if (toolName === 'web_browser_fetch' || toolName === 'web_browser_control') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Browser tools are failing repeatedly — STOP retrying the same navigation/control call.',
        'Change URL/selector, fall back to web_fetch for static content, or report the blocker.',
        'Never invent page contents after repeated browser failures.',
      ].join(' ');
    }
    if (toolName === 'vision_analyze' || toolName === 'screenshot_capture') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Vision/screenshot tools are failing repeatedly — STOP retrying the same image/target.',
        'Change the image/path/region, or report that vision is unavailable.',
        'Never invent image analysis after repeated failures.',
      ].join(' ');
    }
    if (
      toolName === 'device_exec' ||
      toolName === 'device_info' ||
      toolName === 'device_temperature' ||
      toolName === 'device_resources' ||
      toolName === 'device_processes' ||
      toolName === 'device_network' ||
      toolName === 'device_cameras' ||
      toolName === 'device_robotics_status' ||
      toolName === 'fleet_batch'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Device/fleet tools are failing repeatedly — STOP retrying the same board command/target.',
        'Check connectivity, change the command, or report the board blocker.',
        'Never invent device telemetry after repeated failures.',
      ].join(' ');
    }
    if (
      toolName === 'list_directory' ||
      toolName === 'search_code' ||
      toolName === 'search_files' ||
      toolName === 'read_file' ||
      toolName === 'device_file_list' ||
      toolName === 'device_file_read' ||
      toolName.startsWith('codegraph_')
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Discovery is failing repeatedly — STOP retrying the same list/search/read/codegraph hop.',
        'Change the path/pattern/symbol, use a different tool (`search_files` vs `search_code` vs `codegraph_*` vs `list_directory`), or call tool_search group=subagent and then create_subagent scope=explore.',
        'Answer with what you already have; never invent file listings, call graphs, or search hits you did not observe.',
      ].join(' ');
    }
  }
  if (/has failed \d+ time/.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      `${toolName} is not returning usable results right now — STOP calling it.`,
      'Do NOT keep trying variations (different URLs, queries, or paths); that only wastes the turn.',
      'Answer the user with what you already have and state plainly that you could not retrieve the rest via this tool (and why). Never invent, assume, or describe the content you could not actually fetch.',
    ].join(' ');
  }
  if (/different queries/.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'If the previous search results were relevant, pick the best URL and call web_fetch on it.',
      'If the results were irrelevant or empty, stop searching — try web_fetch on a known official URL, or answer with the evidence already gathered.',
      'Do not call web_search again for the same topic in this turn.',
    ].join(' ');
  }
  return [
    `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
    'Do not retry the same preset tool path immediately.',
    'If the preset tool is failing, pivot to an independent evidence source such as an available Web tool (for example web_fetch), local knowledge/files, lower-level device commands, or a simpler diagnostic tool.',
    'Then summarize what changed and continue only with a new approach, or ask the user for the missing decision.',
  ].join(' ');
}

export function shouldShortCircuitToolCall(
  state: ToolLoopGuardState,
  toolName: string,
  input: Record<string, unknown>,
  options: { parallelBatch?: boolean } = {}
): string | null {
  const identicalLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_IDENTICAL_LIMIT',
    DEFAULT_IDENTICAL_TOOL_INPUT_LIMIT
  );
  const singleToolLimit = resolveOptionalPositiveIntEnv('MOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT');
  const totalLimit = resolveOptionalPositiveIntEnv('MOSS_TOOL_LOOP_TOTAL_LIMIT');
  const failureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_FAILURE_LIMIT',
    DEFAULT_TOOL_FAILURE_LIMIT
  );
  const discoveryFailureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT',
    DEFAULT_DISCOVERY_FAILURE_LIMIT
  );
  const editPathFailureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
    DEFAULT_EDIT_PATH_FAILURE_LIMIT
  );
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;
  const failureCount = state.byToolFailure.get(toolName) ?? 0;
  const effectiveFailureLimit =
    DISCOVERY_TOOLS.has(toolName) && discoveryFailureLimit !== undefined
      ? discoveryFailureLimit
      : failureLimit;

  // Per-path edit thrash: block when ANY path in this call is already over the
  // limit (multi_edit/apply_patch can thrash a later path while the first is clean).
  if (SURGICAL_EDIT_TOOLS.has(toolName) && editPathFailureLimit !== undefined) {
    const pathKeys = collectSurgicalEditPathKeys(input);
    for (const pathKey of pathKeys) {
      const pathFails = state.byEditPathFailure.get(pathKey) ?? 0;
      if (pathFails >= editPathFailureLimit) {
        return `edit thrash on ${pathKey}: ${pathFails} failed surgical edit(s) this turn`;
      }
    }
  }

  // O97: once the edit tools refused a path (read scope, or edit thrash), an
  // exec must not write that same file behind their back.
  if (SHELL_TOOLS.has(toolName) && typeof input.command === 'string') {
    const locked = new Set(state.readScopeLockedPaths ?? []);
    const display = new Map<string, string>();
    if (editPathFailureLimit !== undefined) {
      for (const [key, fails] of state.byEditPathFailure) {
        if (fails < editPathFailureLimit) continue;
        const raw = state.editPathRaw?.get(key) ?? key;
        const k = lockKey(state, raw);
        locked.add(k);
        // Display keys keep real casing (findProtectedWrite returns the
        // case-preserving canonical path); folded keys only match the set.
        display.set(
          canonicalPath(path.resolve(state.workspaceDir ?? process.cwd(), raw), false),
          raw
        );
      }
    }
    const base = state.workspaceDir ? canonicalPath(state.workspaceDir, false) : process.cwd();
    const cwd = typeof input.cwd === 'string' && input.cwd ? path.resolve(base, input.cwd) : base;
    const hit = findProtectedWrite(input.command, cwd, locked);
    if (hit) {
      const shown = display.get(hit) ?? path.relative(base, hit) ?? hit;
      return `shell write to edit-locked file ${shown || hit}`;
    }
  }

  if (toolName === 'web_search' && state.hasSufficientRssNewsEvidence) {
    return 'this user turn already has a dated RSS news snapshot with sufficient publisher provenance';
  }
  if (
    toolName === 'web_search' &&
    state.freshNewsSearchRequested &&
    !options.parallelBatch &&
    (input?.recency === 'day' || input?.recency === 'week')
  ) {
    return 'a fresh-news search is already in progress in this assistant step';
  }

  // O96: same-command identical-output streak (independent of byToolFailure).
  if (VERIFY_SHELL_TOOLS.has(toolName)) {
    const sameCmdLimit = resolveOptionalPositiveIntEnv(
      'MOSS_TOOL_LOOP_SAME_COMMAND_LIMIT',
      DEFAULT_SAME_COMMAND_FAILURE_LIMIT
    );
    const sig = normalizeVerifyCommandSignature(toolName, input);
    if (sig && sameCmdLimit !== undefined) {
      const streak = state.bySameCommandFailure.get(sig.key);
      if (streak && streak.count >= sameCmdLimit) {
        return `same check failed repeatedly (${streak.count}×): ${streak.displayCommand}`;
      }
    }
  }

  // web_fetch failures are tracked per-URL (see ToolLoopGuardState), so the
  // block decision for a given web_fetch call keys off its own URL, not the
  // aggregate tool-level counter. A different URL that has never failed stays
  // at 0 and is never blocked by other hosts' failures.
  if (toolName === 'web_fetch' && failureLimit !== undefined) {
    const urlKey = normalizeWebFetchUrlKey(input);
    if (urlKey) {
      const urlFailureCount = state.byWebFetchUrlFailure.get(urlKey) ?? 0;
      if (urlFailureCount >= failureLimit) {
        return `web_fetch on ${urlKey} has failed ${urlFailureCount} time(s) in this user turn`;
      }
    }
    // web_fetch without a URL (or with an unparseable one) skips the
    // failure-based short-circuit entirely — there's no stable key to count
    // against, and the identical-input / single-tool / total guards below
    // still bound it.
  } else if (effectiveFailureLimit !== undefined && failureCount >= effectiveFailureLimit) {
    // O96: encode fault kind so the message says 超时 / 未能启动, not "test failed".
    if (VERIFY_SHELL_TOOLS.has(toolName)) {
      const kind = state.lastShellFaultKind.get(toolName) ?? 'unusable';
      if (kind === 'timeout') {
        return `${toolName} timed out ${failureCount} time(s) in this user turn`;
      }
      if (kind === 'start_failure') {
        const missing = state.lastMissingCommand?.get(toolName);
        return `${toolName} failed to start ${failureCount} time(s) in this user turn${
          missing ? ` (missing command: ${missing})` : ''
        }`;
      }
      if (kind === 'killed') {
        return `${toolName} was killed ${failureCount} time(s) in this user turn`;
      }
      return `${toolName} returned unusable results ${failureCount} time(s) in this user turn`;
    }
    return `${toolName} has failed ${failureCount} time(s) in this user turn`;
  }
  if (identicalLimit !== undefined && sameSignatureCount >= identicalLimit) {
    return `identical input was already requested ${sameSignatureCount} time(s) in this user turn`;
  }
  if (
    singleToolLimit !== undefined &&
    !SINGLE_TOOL_LIMIT_EXEMPT_TOOLS.has(toolName) &&
    sameToolCount >= singleToolLimit
  ) {
    return `${toolName} has already been requested ${sameToolCount} time(s) in this user turn`;
  }
  // Per call, including calls batched in one response. A limit of 10 must
  // not let one response execute 30 calls.
  if (totalLimit !== undefined && state.total >= totalLimit) {
    return `the user turn already requested ${state.total} tool call(s)`;
  }

  const webSearchVariationLimit = resolveOptionalPositiveIntEnv(
    'MOSS_WEB_SEARCH_VARIATION_LIMIT',
    DEFAULT_WEB_SEARCH_VARIATION_LIMIT
  );
  if (webSearchVariationLimit !== undefined && toolName === 'web_search') {
    const query = String(input?.query ?? '')
      .trim()
      .toLowerCase();
    if (query && !state.webSearchQueries.has(query)) {
      const distinctCount = state.webSearchQueries.size;
      if (distinctCount >= webSearchVariationLimit) {
        return `web_search has already been called with ${distinctCount} different queries in this user turn`;
      }
    }
  }

  state.bySignature.set(signature, sameSignatureCount + 1);
  state.byTool.set(toolName, sameToolCount + 1);
  state.total += 1;
  if (toolName === 'web_search') {
    const query = String(input?.query ?? '')
      .trim()
      .toLowerCase();
    if (query) state.webSearchQueries.add(query);
    if (input?.recency === 'day' || input?.recency === 'week') {
      state.freshNewsSearchRequested = true;
    }
  }
  return null;
}
