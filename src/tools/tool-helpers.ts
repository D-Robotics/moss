import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { EXTERNAL_DIFF_DISABLED_COMMAND } from '../utils/git-builtin-diff.js';
import { appendGitConfigEnv, untrustedShellGitConfig } from '../utils/git-config-env.js';
import { isExternalDiffConfigKey } from '../utils/git-spawn.js';
import { preferredLocale } from '../utils/locale-preference.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isWorkspaceTrusted } from '../utils/workspace-trust-state.js';
import { errorMessage, isMossError, MossError } from '../errors.js';
import { setFoldedResultListener } from '../context/tool-result-fold.js';

export const IS_WIN = process.platform === 'win32';

export const EXEC_DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MOSS_EXEC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

/**
 * ToolStateManager — encapsulates mutable state shared across tools.
 *
 * Tracks file read timestamps to detect stale writes (when a file is modified
 * between read and write operations). Previously this was module-level state;
 * now it's an instance, enabling per-agent or per-session state isolation.
 */
/** Claude Code FileRead "unchanged since last read" stub — saves context. */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.';

/**
 * Same window, still unchanged, but the earlier result was elided by the tool
 * output budget: the middle is NOT in context, so "refer to the earlier
 * result" would be a lie (Task OS M12 finding #2 — that lie cost 2-3 blind
 * re-read turns per coding run).
 */
export const FILE_UNCHANGED_TRUNCATED_STUB =
  'File unchanged since last read, but the earlier result was TRUNCATED by the output budget — the dropped region is not in context. Re-read just the region you need with offset/limit instead of the whole file.';

export class ToolStateManager {
  private readonly fileReadState = new Map<string, number>();
  /** Last read window per path (`full` or `offset:limit`) for unchanged stubs. */
  private readonly fileReadRange = new Map<string, string>();
  /** Whether the last served window was elided by the tool output budget. */
  private readonly fileReadTruncated = new Map<string, boolean>();

  async recordFileState(resolvedPath: string, rangeKey = 'full', truncated = false): Promise<void> {
    try {
      const st = await fs.stat(resolvedPath);
      this.fileReadState.set(resolvedPath, st.mtimeMs);
      this.fileReadRange.set(resolvedPath, rangeKey);
      this.fileReadTruncated.set(resolvedPath, truncated);
    } catch {
      // File may not exist yet; ignore
    }
  }

  /** True when read_file (or a successful write/edit) recorded this path. */
  hasRecorded(resolvedPath: string): boolean {
    return this.fileReadState.has(resolvedPath);
  }

  /**
   * Claude Code FileRead parity: when the file mtime and the requested window
   * match the last successful read, the full body is still in context — return
   * a short stub instead of re-dumping the file (token + latency win).
   */
  async unchangedSinceLastRead(resolvedPath: string, rangeKey = 'full'): Promise<boolean> {
    return (await this.readReuseState(resolvedPath, rangeKey)) === 'fresh';
  }

  /**
   * Three-way reuse state for a read window: `miss` (never read, other window,
   * or changed on disk), `fresh` (body is still in context — serve the stub),
   * or `truncated` (unchanged but the body was elided — serve the honest stub).
   */
  async readReuseState(
    resolvedPath: string,
    rangeKey = 'full'
  ): Promise<'miss' | 'fresh' | 'truncated'> {
    const seen = this.fileReadState.get(resolvedPath);
    if (seen === undefined) return 'miss';
    if ((this.fileReadRange.get(resolvedPath) ?? 'full') !== rangeKey) return 'miss';
    try {
      const current = (await fs.stat(resolvedPath)).mtimeMs;
      if (Math.abs(current - seen) >= 1) return 'miss';
    } catch {
      return 'miss';
    }
    return this.fileReadTruncated.get(resolvedPath) ? 'truncated' : 'fresh';
  }

  /**
   * Claude Code FileEdit parity: require a prior *full-file* read (or a
   * successful write/edit that re-stamps `full`) before surgical edit.
   * A partial offset/limit page does not unlock full-file old_string matching
   * — that was a thrash hole (edit outside the paged window → miss → retry).
   */
  requirePriorReadError(resolvedPath: string, displayPath: string): string | null {
    if (!this.hasRecorded(resolvedPath)) {
      return (
        `You must call read_file on ${displayPath} at least once before editing it. ` +
        `Read the current contents (full file, or omit offset/limit), then retry the edit with an exact old_string match.`
      );
    }
    const range = this.fileReadRange.get(resolvedPath) ?? 'full';
    if (range !== 'full') {
      return (
        `You only read a partial window of ${displayPath} (${range}). ` +
        `Call read_file again without offset/limit (full file) before edit_file/multi_edit/apply_patch, ` +
        `so old_string can match anywhere in the file.`
      );
    }
    return null;
  }

  async staleWriteError(resolvedPath: string, displayPath: string): Promise<string | null> {
    const seen = this.fileReadState.get(resolvedPath);
    if (seen === undefined) return null;
    let current: number;
    try {
      current = (await fs.stat(resolvedPath)).mtimeMs;
    } catch {
      return null; // File deleted or inaccessible
    }
    if (current > seen + 1) {
      return (
        `File has been modified since you last read it: ${displayPath}. ` +
        `Another process (editor, linter, or a concurrent task) changed it on disk. ` +
        `Read it again to get the current contents before writing, so you do not overwrite those changes.`
      );
    }
    return null;
  }

  clearFileState(): void {
    this.fileReadState.clear();
    this.fileReadRange.clear();
    this.fileReadTruncated.clear();
  }

  /**
   * Drop prior-read credit for one path so the next surgical edit must
   * re-read. Used after old_string miss / failed multi_edit so the model
   * cannot thrash the same unread snapshot (Claude FileEdit discipline).
   */
  invalidateFileState(resolvedPath: string): void {
    this.fileReadState.delete(resolvedPath);
    this.fileReadRange.delete(resolvedPath);
    this.fileReadTruncated.delete(resolvedPath);
  }

  /**
   * A later fold removed this read from context. The next identical read must
   * not say the body is still current; it is truncated and has to be re-read.
   * `pathHint` may be the tool input (relative) while the cache key is absolute.
   */
  markFoldedReadTruncated(pathHint: string): void {
    const hint = pathHint.replaceAll('\\', '/');
    if (!hint) return;
    for (const key of this.fileReadState.keys()) {
      const norm = key.replaceAll('\\', '/');
      if (norm === hint || norm.endsWith(`/${hint}`) || hint.endsWith(`/${norm}`)) {
        this.fileReadTruncated.set(key, true);
      }
    }
  }
}

/**
 * Claude Code findSimilarFile parity: when a path is missing, suggest a
 * similarly named sibling in the same directory (case/extension drift).
 */
export async function findSimilarFileName(
  missingPath: string,
  workspaceDir: string
): Promise<string | null> {
  try {
    const abs = path.isAbsolute(missingPath)
      ? missingPath
      : path.resolve(workspaceDir, missingPath);
    const dir = path.dirname(abs);
    const base = path.basename(abs).toLowerCase();
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    // Normalize separators so authService ≈ auth-service ≈ auth_service
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseNorm = norm(baseNoExt);
    if (baseNorm.length < 3) return null;
    const entries = await fs.readdir(dir);
    const scored: Array<{ name: string; score: number }> = [];
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (lower === base) continue;
      const otherNoExt = lower.replace(/\.[^.]+$/, '');
      const otherNorm = norm(otherNoExt);
      let score = 0;
      if (otherNorm === baseNorm) score = 95;
      else if (otherNorm.includes(baseNorm) || baseNorm.includes(otherNorm)) score = 70;
      else if (
        otherNorm.startsWith(baseNorm.slice(0, Math.min(5, baseNorm.length))) ||
        baseNorm.startsWith(otherNorm.slice(0, Math.min(5, otherNorm.length)))
      ) {
        score = 40;
      }
      if (score > 0) scored.push({ name, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const hit = scored[0];
    if (!hit || hit.score < 60) return null;
    const rel = path.relative(workspaceDir, path.join(dir, hit.name)).split(path.sep).join('/');
    return rel || hit.name;
  } catch {
    return null;
  }
}

// Global instance for now; enables future injection per agent/session
export const globalToolStateManager = new ToolStateManager();

function foldedReadPath(input: Record<string, unknown>): string | null {
  const filePath = input.file_path;
  if (typeof filePath === 'string' && filePath.length > 0) return filePath;
  const rawPath = input.path;
  if (typeof rawPath === 'string' && rawPath.length > 0) return rawPath;
  return null;
}

// Folding a read drops the body. The read cache must stop serving "unchanged,
// refer to the earlier result" for that path. read / read_file own this cache.
setFoldedResultListener((toolName, input) => {
  if (toolName !== 'read' && toolName !== 'read_file') return;
  const hint = foldedReadPath(input);
  if (!hint) return;
  globalToolStateManager.markFoldedReadTruncated(hint);
});

/**
 * Detect whether captured stdout looks like binary data (e.g. `cat /bin/ls`).
 * runProcess captures as UTF-8, so binary produces U+FFFD replacement chars
 * and control chars. If more than 10% of chars are non-printable, treat as
 * binary so exec-style tools return a safe summary instead of flooding the
 * model's context. Shared by the local exec tool and device tools.
 * @public
 */
export function looksBinary(text: string): boolean {
  if (!text || text.length < 20) return false;
  let nonPrintable = 0;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfffd || code === 0) {
      nonPrintable++;
      continue;
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
      continue;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

export interface OpenedChildEnv {
  env: Record<string, string>;
  /** Moss replaced or disabled this repo's hooks for the child. */
  repoHooksSkipped: boolean;
  /** Local external diff was pointed at `false` because the builtin script was unsafe. */
  externalDiffDisabled: boolean;
}

const repoHooksNotified = new Set<string>();
const externalDiffNotified = new Set<string>();

function sessionNoticeId(sessionKey: string | undefined): string {
  return sessionKey?.trim() || '__moss_session__';
}

function zhNotices(): boolean {
  return /^zh/i.test(preferredLocale() ?? '');
}

/**
 * True when `command` invokes git: a command word whose basename is `git`
 * (or `git.exe`), including after a path prefix and after shell separators.
 * Leading `NAME=value` assignments are skipped. A `git` inside `echo "git"`
 * or a name like `gitignore` does not count. `bash -c "git …"` / `sh -c`
 * (and `-lc`) scan the command string. `xargs git` counts; `xargs echo git`
 * does not.
 */
export function commandInvokesGit(command: string): boolean {
  return scanShellCommands(command, 0, command.length);
}

function scanShellCommands(command: string, start: number, end: number): boolean {
  let i = start;
  let atCommand = true;
  while (i < end) {
    const ch = command[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      atCommand = true;
      i += 1;
      continue;
    }
    if (ch === '`') {
      const close = command.indexOf('`', i + 1);
      const innerEnd = close === -1 || close > end ? end : close;
      if (scanShellCommands(command, i + 1, innerEnd)) return true;
      i = innerEnd < end ? innerEnd + 1 : end;
      atCommand = false;
      continue;
    }
    if (command.startsWith('$(', i)) {
      const innerEnd = matchingParen(command, i + 1, end);
      if (scanShellCommands(command, i + 2, innerEnd)) return true;
      i = innerEnd < end ? innerEnd + 1 : end;
      atCommand = false;
      continue;
    }
    if (atCommand) {
      const assigned = envAssignmentEnd(command, i, end);
      if (assigned > i) {
        i = assigned;
        continue;
      }
    }
    const word = readShellWord(command, i, end);
    if (word.invokesGit) return true;
    if (word.next === i) {
      i += 1;
      continue;
    }
    if (atCommand && isGitCommandToken(word.text)) return true;
    if (atCommand && shellDashCInvokesGit(command, word)) return true;
    if (atCommand && xargsInvokesGit(command, word)) return true;
    i = word.next;
    atCommand = false;
  }
  return false;
}

function commandBase(word: string): string {
  return word.split(/[/\\]/).pop() ?? word;
}

function isGitCommandToken(word: string): boolean {
  if (!word || word.includes('=')) return false;
  const base = commandBase(word);
  return base === 'git' || base.toLowerCase() === 'git.exe';
}

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

function isShellInterpreter(word: string): boolean {
  return SHELL_INTERPRETERS.has(commandBase(word));
}

function skipShellSpace(command: string, i: number, end: number): number {
  while (i < end) {
    const ch = command[i] ?? '';
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') break;
    i += 1;
  }
  return i;
}

function isShellBoundary(ch: string): boolean {
  return ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')';
}

/** `sh -c` / `bash -lc` script. Other positional arguments are not scanned. */
function shellDashCInvokesGit(command: string, word: { text: string; next: number }): boolean {
  if (!isShellInterpreter(word.text)) return false;
  let j = word.next;
  let sawC = false;
  const end = command.length;
  while (j < end) {
    j = skipShellSpace(command, j, end);
    if (j >= end || isShellBoundary(command[j] ?? '')) return false;
    const next = readShellWord(command, j, end);
    if (next.next === j) return false;
    if (!sawC) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(next.text)) {
        sawC = true;
        j = next.next;
        continue;
      }
      if (next.text.startsWith('-')) {
        j = next.next;
        continue;
      }
      return false;
    }
    return scanShellCommands(next.text, 0, next.text.length);
  }
  return false;
}

const XARGS_OPTIONS_WITH_ARG = new Set([
  '-a',
  '-d',
  '-E',
  '-e',
  '-I',
  '-i',
  '-L',
  '-l',
  '-n',
  '-P',
  '-s',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--replace',
  '--max-lines',
  '--max-args',
  '--max-procs',
  '--max-chars',
]);

function xargsOptionTakesArg(text: string): boolean {
  if (text.startsWith('--')) return !text.includes('=') && XARGS_OPTIONS_WITH_ARG.has(text);
  if (!/^-[A-Za-z]+$/.test(text)) return false;
  const last = text[text.length - 1] ?? '';
  return 'adEeIiLlnPs'.includes(last);
}

/** `xargs git` and `xargs -n 1 git`. The utility is the first non-option word. */
function xargsInvokesGit(command: string, word: { text: string; next: number }): boolean {
  if (commandBase(word.text) !== 'xargs') return false;
  let j = word.next;
  let afterDoubleDash = false;
  const end = command.length;
  while (j < end) {
    j = skipShellSpace(command, j, end);
    if (j >= end || isShellBoundary(command[j] ?? '')) return false;
    const next = readShellWord(command, j, end);
    if (next.next === j) return false;
    if (!afterDoubleDash && next.text === '--') {
      afterDoubleDash = true;
      j = next.next;
      continue;
    }
    if (!afterDoubleDash && next.text.startsWith('-')) {
      j = next.next;
      if (xargsOptionTakesArg(next.text)) {
        j = skipShellSpace(command, j, end);
        if (j >= end || isShellBoundary(command[j] ?? '')) return false;
        const arg = readShellWord(command, j, end);
        if (arg.next === j) return false;
        j = arg.next;
      }
      continue;
    }
    return isGitCommandToken(next.text);
  }
  return false;
}

function envAssignmentEnd(command: string, i: number, end: number): number {
  const match = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(command.slice(i, end));
  if (!match) return i;
  let j = i + match[0].length;
  const quote = command[j];
  if (quote === '"' || quote === "'") return skipQuoted(command, j, end);
  while (j < end) {
    const ch = command[j] ?? '';
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\r' ||
      ch === '\n' ||
      ch === ';' ||
      ch === '|' ||
      ch === '&' ||
      ch === '(' ||
      ch === ')' ||
      ch === '<' ||
      ch === '>'
    ) {
      break;
    }
    j += 1;
  }
  return j;
}

function skipQuoted(command: string, i: number, end: number): number {
  const quote = command[i];
  let j = i + 1;
  while (j < end) {
    const ch = command[j] ?? '';
    if (quote === '"' && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    j += 1;
  }
  return end;
}

function matchingParen(command: string, openIndex: number, end: number): number {
  let depth = 0;
  let j = openIndex;
  while (j < end) {
    const ch = command[j] ?? '';
    if (ch === '"' || ch === "'") {
      j = skipQuoted(command, j, end);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return end;
}

function readShellWord(
  command: string,
  i: number,
  end: number
): { text: string; next: number; invokesGit: boolean } {
  let text = '';
  let invokesGit = false;
  let j = i;
  while (j < end) {
    const ch = command[j] ?? '';
    if (ch === '"' || ch === "'") {
      const quote = ch;
      j += 1;
      while (j < end && (command[j] ?? '') !== quote) {
        if (quote === '"' && (command[j] ?? '') === '\\') {
          text += command[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (quote === '"' && command.startsWith('$(', j)) {
          const innerEnd = matchingParen(command, j + 1, end);
          if (scanShellCommands(command, j + 2, innerEnd)) invokesGit = true;
          j = innerEnd < end ? innerEnd + 1 : end;
          continue;
        }
        if (quote === '"' && (command[j] ?? '') === '`') {
          const close = command.indexOf('`', j + 1);
          const innerEnd = close === -1 || close > end ? end : close;
          if (scanShellCommands(command, j + 1, innerEnd)) invokesGit = true;
          j = innerEnd < end ? innerEnd + 1 : end;
          continue;
        }
        text += command[j] ?? '';
        j += 1;
      }
      if (j < end && (command[j] ?? '') === quote) j += 1;
      continue;
    }
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\r' ||
      ch === '\n' ||
      ch === ';' ||
      ch === '|' ||
      ch === '&' ||
      ch === '(' ||
      ch === ')' ||
      ch === '<' ||
      ch === '>' ||
      ch === '`'
    ) {
      break;
    }
    if (command.startsWith('$(', j)) break;
    text += ch;
    j += 1;
  }
  return { text, next: j, invokesGit };
}

function repoHooksNoticeLine(): string {
  return zhNotices()
    ? '[moss] 未受信任工作区中的仓库钩子未运行。'
    : '[moss] Repo hooks in an untrusted workspace were not run.';
}

function externalDiffDisabledNoticeLine(): string {
  return zhNotices()
    ? '[moss] 仓库的外部 diff 已禁用。'
    : "[moss] The repo's external diff was disabled.";
}

const EXTERNAL_DIFF_DIED = /external diff died/i;

/**
 * Notices for an untrusted shell, appended to the tool result. The once-per
 * session flag is consumed only when `command` actually invokes git, so an
 * earlier `ls` does not hide the line from the next `git` command. When git
 * prints `external diff died` after the drivers were pointed at `false`, the
 * disabled explanation is attached again even if `git status` already spent
 * the once-per-session notice. The TUI peels a trailing `[moss]` line into
 * its own row.
 */
export function takeShellNotices(
  sessionKey: string | undefined,
  opened: Pick<OpenedChildEnv, 'repoHooksSkipped' | 'externalDiffDisabled'>,
  command: string,
  output = ''
): string {
  const invokes = commandInvokesGit(command);
  const died = opened.externalDiffDisabled && EXTERNAL_DIFF_DIED.test(output);
  if (!invokes && !died) return '';
  const id = sessionNoticeId(sessionKey);
  const lines: string[] = [];
  if (invokes && opened.repoHooksSkipped && !repoHooksNotified.has(id)) {
    repoHooksNotified.add(id);
    lines.push(repoHooksNoticeLine());
  }
  if (opened.externalDiffDisabled && (died || (invokes && !externalDiffNotified.has(id)))) {
    externalDiffNotified.add(id);
    lines.push(externalDiffDisabledNoticeLine());
  }
  if (lines.length === 0) return '';
  return `\n\n${lines.join('\n')}`;
}

/**
 * Child environment for model shells. Untrusted workspaces get git config
 * overrides appended to any `GIT_CONFIG_COUNT` the user already set. Trusted
 * workspaces are unchanged. `repoHooksSkipped` is true when this env disables
 * the repo's own hooks. `externalDiffDisabled` is true when a local external
 * diff was pointed at `false`.
 */
export async function openChildEnv(
  workspaceDir?: string,
  signal?: AbortSignal
): Promise<OpenedChildEnv> {
  const env = safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' });
  const dir =
    typeof workspaceDir === 'string' && workspaceDir.trim() ? workspaceDir : process.cwd();
  if (isWorkspaceTrusted(dir)) {
    return { env, repoHooksSkipped: false, externalDiffDisabled: false };
  }
  const pairs = await untrustedShellGitConfig(dir, signal);
  appendGitConfigEnv(env, pairs);
  const repoHooksSkipped = pairs.some((pair) => pair.key.toLowerCase() === 'core.hookspath');
  const externalDiffDisabled = pairs.some(
    (pair) => isExternalDiffConfigKey(pair.key) && pair.value === EXTERNAL_DIFF_DISABLED_COMMAND
  );
  return { env, repoHooksSkipped, externalDiffDisabled };
}

/** {@link openChildEnv} without the hooks-skip flag. */
export async function childEnv(
  workspaceDir?: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  return (await openChildEnv(workspaceDir, signal)).env;
}

export async function safePath(inputPath: string, workspaceDir: string): Promise<string> {
  const { resolved } = await assertSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

export function toolError(prefix: string, err: unknown): Error {
  if (isMossError(err)) {
    return new MossError({
      code: err.code,
      message: `${prefix}: ${err.message}`,
      hint: err.hint,
      recoverable: err.recoverable,
      context: err.context,
      cause: err,
    });
  }
  return new Error(`${prefix}: ${errorMessage(err)}`);
}

export const LINE_NUMBER_WIDTH = 6;

export function withLineNumbers(text: string, startLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n');
}

/**
 * Meaningful tail lines from a failed exec/device_exec tool result for TUI rows.
 * Skips bare `exit_code: N` / section headers so users see the real error without Ctrl+O.
 */
export function extractCommandFailurePreview(resultText: string, maxLines = 4): string[] {
  const text = String(resultText ?? '');
  if (!text.trim()) return [];

  // Prefer stderr section when present.
  let body = text;
  const stderrSection = text.match(/--- stderr(?:[^\n]*)---\s*([\s\S]*)$/i);
  if (stderrSection?.[1]?.trim()) {
    body = stderrSection[1];
  }

  const rawLines = body.split('\n').map((l) => l.trimEnd());
  const candidates: string[] = [];
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const line = rawLines[i]!.trim();
    if (!line) continue;
    if (/^exit_code:\s*\d+\b/i.test(line)) continue;
    if (/^---\s*(?:stdout|stderr)/i.test(line)) continue;
    if (/^\(no output\)$/i.test(line)) continue;
    if (/chars omitted|truncated to ~/i.test(line)) continue;
    if (/^Command failed \(exit/i.test(line) && candidates.length === 0) {
      // Keep as fallback but continue looking for more specific lines first.
      candidates.push(line.length > 120 ? `${line.slice(0, 119)}…` : line);
      continue;
    }
    candidates.push(line.length > 120 ? `${line.slice(0, 119)}…` : line);
    if (candidates.length >= maxLines) break;
  }
  return candidates.reverse();
}

/**
 * Compact tail preview for successful exec/device_exec tool rows.
 * Keeps noise low: only when output is multi-line / long enough to hide useful info.
 */
export function extractCommandOutputPreview(
  resultText: string,
  options: { maxLines?: number; minChars?: number; minLines?: number } = {}
): string[] {
  const maxLines = options.maxLines ?? 3;
  const minChars = options.minChars ?? 160;
  const minLines = options.minLines ?? 4;
  const text = String(resultText ?? '').trim();
  if (!text) return [];

  // Prefer stdout body; drop stderr section for success previews (failures use extractCommandFailurePreview).
  let body = text;
  const stderrIdx = body.search(/\n--- stderr/i);
  if (stderrIdx >= 0) body = body.slice(0, stderrIdx).trim();
  body = body.replace(/^exit_code:\s*0\s*\n?/i, '').trim();
  if (!body || body === '(no output)') return [];

  const lines = body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^---\s*(?:stdout|stderr)/i.test(t)) return false;
      if (/chars omitted|truncated to ~/i.test(t)) return false;
      return true;
    });

  if (lines.length < minLines && body.length < minChars) return [];

  const tail = lines.slice(-maxLines).map((l) => {
    const t = l.trim();
    return t.length > 100 ? `${t.slice(0, 99)}…` : t;
  });
  // If we elided earlier lines, mark it.
  if (lines.length > maxLines) {
    return [`… ${lines.length - maxLines} earlier lines`, ...tail];
  }
  return tail;
}
