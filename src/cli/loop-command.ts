/**
 * `moss loop --until <cmd> "<prompt>"` — the local closed loop.
 *
 * Cursor's `/loop` and autopilot run the agent, check the result, and feed the
 * failure back until the check passes or the budget is spent. This is the local,
 * scriptable equivalent: each attempt is a fresh headless one-shot (no shared
 * conversation state), then the user's own command decides. The loop never
 * declares success on its own — exit 0 comes only from the check command.
 */
import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { runOneShotWithCliCancellation } from './run-cancellation.js';
import { createSessionUsageAccumulator } from './session-usage.js';
import { runUsageFromSlices } from './run-usage.js';
import { runProcess } from '../utils/run-process.js';
import { isZhLocale } from './cli-locale.js';
import type { MossAgent } from '../core/agent/moss-agent.js';

export interface LoopCommandContext {
  agent: MossAgent;
  workspaceDir: string;
}

export interface LoopOptions {
  prompt: string;
  until: string;
  maxAttempts: number;
  /** D13: fixed delay between failed attempts, so OS cron/`--every` can pace a loop. */
  everyMs: number;
  /** Whole-loop wall clock cap; 0 means unlimited. Checked between attempts. */
  maxDurationMs: number;
  /** External signal: wait for this path (or glob) to change before the next attempt. */
  watch?: string;
  /** Treat a literal directory as `<dir>/**`, so nested artifacts can wake the loop. */
  watchRecursive?: boolean;
  /** How long `--watch` waits for a change before ending the loop (0 = default 10m). */
  watchTimeoutMs: number;
  /** Cap on a single `--until` run; a hang stops the loop instead of eating attempts. */
  untilTimeoutMs: number;
}

/** First line of a run: lets `loop list` tell "still running" from "killed". */
interface LoopStartRecord {
  type: 'start';
  runId: string;
  at: string;
  /** OS process id of the loop; liveness is checked when no summary exists. */
  pid: number;
  until: string;
  maxAttempts: number;
  prompt: string;
  /** Legacy ledgers may lack this; the check cap is per-run. */
  untilTimeoutMs?: number;
}

/** One line per attempt, so an overnight loop can be audited afterwards. */
interface LoopAttemptRecord {
  type: 'attempt';
  runId: string;
  attempt: number;
  at: string;
  durationMs: number;
  sessionKey: string;
  agentError?: string;
  check: {
    exitCode: number;
    durationMs: number;
    stdout: string;
    stderr: string;
    /** The check never answered: killed by `--until-timeout`, not a verdict. */
    timedOut?: boolean;
  };
  passed: boolean;
  /** Wall-clock spent waiting for `--watch` before this attempt. */
  waitedMs?: number;
}

interface LoopSummaryRecord {
  type: 'summary';
  runId: string;
  at: string;
  passed: boolean;
  attempts: number;
  maxAttempts: number;
  maxDurationMs: number;
  totalDurationMs: number;
  reason: 'passed' | 'attempts_exhausted' | 'budget_exhausted' | 'watch_timeout' | 'check_timeout';
  until: string;
  untilTimeoutMs?: number;
  /** The external signal (path / glob / `<dir>/**`), when `--watch` was used. */
  watch?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000;
const WATCH_POLL_MS = 500;
/**
 * `*`, `?` or `[` switches `--watch` from a literal path to a glob pattern.
 * A filename may legitimately contain them, but the shell-like interpretation
 * is what users type these characters for; the usage text states the rule so
 * the choice is never a surprise (quote nothing, or pass the literal path).
 */
const GLOB_META_RE = /[*?[]/;
const GLOB_MAX_PATTERN_CHARS = 512;
/**
 * A `**` watch can walk an entire workspace. These caps keep one poll bounded
 * and surface the truncation in the signature instead of silently shrinking it.
 */
const GLOB_MAX_VISITED = 20_000;
const GLOB_MAX_MATCHES = 2_000;
const GLOB_MAX_DEPTH = 32;
const MAX_ATTEMPTS_CAP = 20;
const DEFAULT_UNTIL_TIMEOUT_MS = 10 * 60_000;
/** `moss loop prune` keeps the newest 50 finished runs unless `--keep` says otherwise. */
const DEFAULT_LOOP_KEEP = 50;

export function renderLoopUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss loop --until "<命令>" [--max N] [--every <时长>] [--max-duration <时长>] "<prompt>"',
      '',
      '  每轮：用 prompt 跑一次全新的 headless 会话 → 执行 --until 命令。',
      '  命令退出 0 即成功（exit 0）；失败会把输出尾部喂回下一轮（最多 N 次，默认 3）。',
      '  --until 不能省略：循环的成败只由你的命令判定，不由模型自述判定。',
      '  --every 5m：两次尝试之间固定等待（支持 ms/s/m/h，默认 0 = 立即重试）。',
      '  --max-duration 30m：整轮墙钟上限，只在两次尝试之间检查（进行中的一轮不会被切断）。',
      '  --watch <路径|模式>：失败后等它变化再跑下一轮（外部信号唤醒，如 CI 产物落地）。',
      '    含 * ? [ 时按 glob 解释：支持 * ? [abc] 与 **（任意层，**/ 可以是零层），例如 build/**/*.txt。',
      '  --watch-recursive：配合 --watch 把字面目录当 <目录>/** 监视（任意深度的子文件）。',
      '  --watch-timeout 10m：等不到变化就收工（summary reason=watch_timeout，不烧剩余轮次）。',
      '  --until-timeout 10m：单次检查命令的墙钟上限；挂起（例如等 stdin）就停止并记 reason=check_timeout，不当作判定失败、不烧剩余轮次。',
      '  每轮的退出码/耗时/检查输出尾部/改动会写进 .moss/loops/<runId>.jsonl（启动时打印路径）。',
      '  moss loop list [--limit N] [--status passed|failed|running|interrupted] [--json]：历史运行（最新在前，离线读账本）；表头给出总数与各状态计数。',
      '  moss loop show [<run_id>|latest] [--json]：某次运行的每轮明细与检查输出。',
      '  moss loop follow [<run_id>|latest] [--interval 1s]：实时跟随一次运行，新 attempt/summary 出现就打印（Ctrl+C 退出）。',
      '  moss loop prune [--keep N] [--dry-run] [--json]：清理旧账本，默认保留最新 50 个已结束运行；进行中的运行永不删除（离线）。',
      '',
      '示例：',
      '  moss loop --until "npm run verify" "修复 verify 的失败项，最小改动"',
      '  moss loop --until "moss review check" --max 2 "按评审意见修复并复评"',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss loop --until "<command>" [--max N] [--every <duration>] [--max-duration <duration>] "<prompt>"',
    '',
    '  Each attempt runs one fresh headless session with the prompt, then runs the',
    '  --until command. Exit 0 of that command means success (loop exits 0); on',
    '  failure the output tail is fed into the next attempt (default 3 attempts).',
    '  --until is required: only your command decides, never the model prose.',
    '  --every 5m waits a fixed delay between failed attempts (ms/s/m/h; default 0 = retry now).',
    '  --max-duration 30m caps the whole loop in wall-clock terms; checked between attempts',
    '  (an attempt already running is not cut off).',
    '  --watch <path|pattern> waits for it to change before the next attempt',
    '  (an external signal such as a CI artifact). A value containing * ? or [ is a',
    '  glob — * ? [abc] and ** (any depth; **/ matches zero or more dirs), e.g.',
    '  build/**/*.txt — and the wait line prints the matched file count. --watch-recursive',
    '  treats a literal directory as <dir>/** (children at any depth). --watch-timeout 10m',
    '  gives up and ends the loop with summary reason watch_timeout instead of burning attempts.',
    '  --until-timeout 10m caps one run of the check command; a hang (e.g. waiting on stdin)',
    '  stops the loop with summary reason check_timeout rather than being treated as a verdict.',
    '  --every and --watch can be combined: the fixed delay runs, then the watch wait.',
    '  The ledger for every attempt (exit code, duration, check output tails) is',
    '  written to .moss/loops/<runId>.jsonl and the path is printed at startup.',
    '  moss loop list [--limit N] [--status passed|failed|running|interrupted] [--json]',
    '  reads the run history (offline, newest first); the header counts every status.',
    "  moss loop show [<run_id>|latest] [--json] prints one run's attempts and check tails.",
    '  moss loop prune [--keep N] [--dry-run] [--json] deletes old ledgers, keeping the newest N',
    '  finished runs (default 50); a run still in progress is never deleted. `--dry-run` only',
    '  reports what it would remove.',
    '',
    'Examples:',
    '  moss loop --until "npm run verify" "fix the verify failures with minimal changes"',
    '  moss loop --until "moss review check" --max 2 "address the review findings"',
  ].join('\n');
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const arg = argv[index] ?? '';
  const eq = arg.indexOf('=');
  if (eq !== -1) return arg.slice(eq + 1);
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`${flag} needs a value`);
  }
  return next;
}

const MAX_EVERY_MS = 24 * 60 * 60 * 1000;

/** `250ms` / `30s` / `5m` / `1h` / bare seconds; 0 disables the delay. */
export function parseLoopDuration(raw: string, flag = '--every'): number {
  const text = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) throw new Error(`${flag} needs a duration like 30s, 5m, 1h (got "${raw}")`);
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = Math.round(value * multiplier);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_EVERY_MS) {
    throw new Error(`${flag} must be between 0 and 24h (got "${raw}")`);
  }
  return ms;
}

export function parseLoopArgs(argv: readonly string[]): LoopOptions {
  const rest: string[] = [];
  let until: string | undefined;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let everyMs = 0;
  let maxDurationMs = 0;
  let watch: string | undefined;
  let watchRecursive = false;
  let watchTimeoutMs = 0;
  let untilTimeoutMs = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--until' || arg.startsWith('--until=')) {
      until = readValue(argv, i, '--until');
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg === '--max' || arg.startsWith('--max=')) {
      const raw = readValue(argv, i, '--max');
      if (!arg.includes('=')) i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error('--max must be a positive integer');
      maxAttempts = Math.min(MAX_ATTEMPTS_CAP, parsed);
      continue;
    }
    if (arg === '--every' || arg.startsWith('--every=')) {
      const raw = readValue(argv, i, '--every');
      if (!arg.includes('=')) i += 1;
      everyMs = parseLoopDuration(raw, '--every');
      continue;
    }
    if (arg === '--max-duration' || arg.startsWith('--max-duration=')) {
      const raw = readValue(argv, i, '--max-duration');
      if (!arg.includes('=')) i += 1;
      maxDurationMs = parseLoopDuration(raw, '--max-duration');
      continue;
    }
    if (arg === '--watch-recursive') {
      watchRecursive = true;
      continue;
    }
    if (arg === '--watch' || arg.startsWith('--watch=')) {
      const raw = readValue(argv, i, '--watch');
      if (!arg.includes('=')) i += 1;
      watch = raw.trim();
      if (watch === '') throw new Error('--watch needs a file, directory, or glob pattern');
      if (hasGlobMeta(watch) && watch.length > GLOB_MAX_PATTERN_CHARS) {
        throw new Error(
          `--watch pattern is too long (${String(watch.length)} > ${String(GLOB_MAX_PATTERN_CHARS)} chars)`
        );
      }
      continue;
    }
    if (arg === '--until-timeout' || arg.startsWith('--until-timeout=')) {
      const raw = readValue(argv, i, '--until-timeout');
      if (!arg.includes('=')) i += 1;
      untilTimeoutMs = parseLoopDuration(raw, '--until-timeout');
      if (untilTimeoutMs === 0) {
        throw new Error('--until-timeout must be greater than 0');
      }
      continue;
    }
    if (arg === '--watch-timeout' || arg.startsWith('--watch-timeout=')) {
      const raw = readValue(argv, i, '--watch-timeout');
      if (!arg.includes('=')) i += 1;
      watchTimeoutMs = parseLoopDuration(raw, '--watch-timeout');
      if (watchTimeoutMs === 0) {
        throw new Error('--watch-timeout must be greater than 0');
      }
      continue;
    }
    rest.push(arg);
  }
  const prompt = rest.join(' ').trim();
  if (!until) throw new Error('--until is required: the loop must end on a command, not on prose');
  if (!prompt) throw new Error('the prompt is required');
  if (watchRecursive && watch === undefined) {
    throw new Error('--watch-recursive needs --watch <directory>');
  }
  if (watchRecursive && watch !== undefined && hasGlobMeta(watch)) {
    // A pattern already reaches any depth; silently accepting both would leave
    // the user without a way to tell which one decided the signature.
    throw new Error('--watch-recursive cannot be combined with a glob pattern');
  }
  return {
    prompt,
    until,
    maxAttempts,
    everyMs,
    maxDurationMs,
    ...(watch !== undefined ? { watch } : {}),
    ...(watchRecursive ? { watchRecursive: true } : {}),
    watchTimeoutMs: watchTimeoutMs > 0 ? watchTimeoutMs : DEFAULT_WATCH_TIMEOUT_MS,
    untilTimeoutMs: untilTimeoutMs > 0 ? untilTimeoutMs : DEFAULT_UNTIL_TIMEOUT_MS,
  };
}

export interface WatchState {
  /** Stable textual signature; `missing:` when the path does not exist. */
  signature: string;
  exists: boolean;
  /** Files the pattern matched (glob / recursive watches only). */
  matches?: number;
  /** The normalized pattern, so logs can name what is actually watched. */
  pattern?: string;
}

export interface WatchOptions {
  /** Treat a literal directory as `<dir>/**` (children at any depth). */
  recursive?: boolean;
}

/** `*`, `?` or `[` means the argument is a pattern, not a literal path. */
export function hasGlobMeta(target: string): boolean {
  return GLOB_META_RE.test(target);
}

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * One path segment → regex source. `*` and `?` never cross `/`, character
 * classes are passed through (escaped), everything else is a literal. A `[`
 * without a closing `]` is a literal bracket, like in a POSIX shell.
 */
function segmentToRegExpSource(segment: string): string {
  let source = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? '';
    if (ch === '*') {
      source += '[^/]*';
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close > i + 1) {
        const body = segment.slice(i + 1, close);
        const negated = body.startsWith('!');
        const inner = (negated ? body.slice(1) : body).replace(/[\\\]]/g, (m) => `\\${m}`);
        source += `[${negated ? '^' : ''}${inner}]`;
        i = close;
        continue;
      }
    }
    source += escapeRegExpChar(ch);
  }
  return source;
}

/**
 * Compile a glob to an anchored regexp. Literals are escaped, so a pattern can
 * never inject regex syntax; the only unbounded quantifiers are `[^/]*` (inside
 * a segment) and `(?:[^/]+/)*` (a `**` directory run), both linear per segment.
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/').filter((segment, index, all) => {
    // Keep leading '' for an absolute pattern; drop empty trailing/duplicate ones.
    if (segment !== '') return true;
    return index === 0 && all.length > 1;
  });
  let source = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const last = i === segments.length - 1;
    if (segment === '**') {
      // A trailing `**` matches everything below; otherwise zero or more dirs.
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    source += segmentToRegExpSource(segment);
    if (!last) source += '/';
  }
  return new RegExp(`${source}$`);
}

interface GlobBase {
  baseDir: string;
  segments: string[];
}

/** Split a pattern into the literal base directory and the pattern below it. */
function splitGlobPattern(rawPattern: string): GlobBase {
  const pattern = rawPattern.replace(/\\/g, '/');
  const parts = pattern.split('/');
  const firstMeta = parts.findIndex((part) => hasGlobMeta(part));
  const literalParts = firstMeta === -1 ? parts : parts.slice(0, firstMeta);
  const segments = (firstMeta === -1 ? [] : parts.slice(firstMeta)).filter(
    (segment) => segment !== ''
  );
  const baseDir = path.resolve(literalParts.join('/') || '.');
  const normalizedSegments = segments.length === 0 ? ['*'] : segments;
  return { baseDir, segments: normalizedSegments };
}

interface GlobMatch {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface GlobScan {
  matches: GlobMatch[];
  truncated: boolean;
}

/**
 * Walk `baseDir` and collect the files matching the compiled pattern.
 *
 * Bounded on purpose: `**` on a real workspace can reach `node_modules`, so the
 * scan stops at GLOB_MAX_VISITED entries / GLOB_MAX_MATCHES files and reports
 * the truncation in the signature. Symlinks are not followed (a cycle would
 * hang the poll, and the poll must stay a cheap no-op).
 */
async function scanGlob(baseDir: string, segments: readonly string[]): Promise<GlobScan> {
  const matcher = globToRegExp(segments.join('/'));
  const matches: GlobMatch[] = [];
  let visited = 0;
  let truncated = false;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > GLOB_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable or vanished: nothing below it this poll.
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      visited += 1;
      if (visited > GLOB_MAX_VISITED || matches.length >= GLOB_MAX_MATCHES) {
        truncated = true;
        return;
      }
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matcher.test(relativePath)) continue;
      try {
        const child = await fs.promises.stat(absolutePath);
        matches.push({ relativePath, size: child.size, mtimeMs: child.mtimeMs });
      } catch {
        // Deleted between readdir and stat: it simply is not a match now.
      }
    }
  };
  await walk(baseDir, '', 0);
  matches.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  return { matches, truncated };
}

async function globSignature(rawPattern: string): Promise<WatchState> {
  const display = rawPattern.replace(/\\/g, '/').replace(/\/+$/, '');
  const { baseDir, segments } = splitGlobPattern(rawPattern);
  const { matches, truncated } = await scanGlob(baseDir, segments);
  const body = matches
    .map((match) => `${match.relativePath}:${String(match.size)}:${String(match.mtimeMs)}`)
    .join(',');
  return {
    signature: `glob:${display}:${truncated ? 'truncated:' : ''}${String(matches.length)}:${body}`,
    // `exists` keeps the literal meaning ("is there anything to watch yet"), so
    // a first match after `missing:` reads as an appearance.
    exists: matches.length > 0,
    matches: matches.length,
    pattern: display,
  };
}

/**
 * Cheap signature of a file, a directory's direct children, or a glob match set
 * (name + size + mtime, bounded). The loop only needs "did anything change",
 * not a full content diff. Literal paths keep their exact pre-glob signature.
 */
export async function watchSignature(
  target: string,
  options: WatchOptions = {}
): Promise<WatchState> {
  if (hasGlobMeta(target)) return await globSignature(target);
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory())
      return { signature: `file:${String(stat.size)}:${String(stat.mtimeMs)}`, exists: true };
    if (options.recursive === true) {
      const trimmed = target.replace(/[\\/]+$/, '');
      return await globSignature(`${trimmed}/**`);
    }
    const entries = (await fs.promises.readdir(target)).sort().slice(0, 200);
    const parts: string[] = [];
    for (const name of entries) {
      try {
        const child = await fs.promises.stat(path.join(target, name));
        parts.push(`${name}:${String(child.size)}:${String(child.mtimeMs)}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return { signature: `dir:${parts.join(',')}`, exists: true };
  } catch {
    return { signature: 'missing:', exists: false };
  }
}

export interface WatchWaitResult {
  changed: boolean;
  waitedMs: number;
  before: WatchState;
  after: WatchState;
}

/**
 * What `--watch` actually watches: a recursive literal directory is `<dir>/**`
 * (the ledger then says so instead of claiming one directory was watched).
 */
export function watchTargetLabel(watch: string, recursive: boolean): string {
  if (!recursive || hasGlobMeta(watch)) return watch;
  return `${watch.replace(/[\\/]+$/, '')}/**`;
}

/**
 * `watch: build/**\/*.txt (3 files)` — what the wait is actually comparing, so a
 * `**` pattern that matched nothing is visible instead of silently waiting.
 */
export function describeWatchState(target: string, state: WatchState): string {
  const label = state.pattern ?? target;
  if (state.matches === undefined) return `watch: ${label}`;
  return `watch: ${label} (${String(state.matches)} file${state.matches === 1 ? '' : 's'})`;
}

export interface WatchWaitOptions extends WatchOptions {
  timeoutMs: number;
  pollMs?: number;
  /**
   * Reuse a just-sampled state so the caller's log line and the comparison in
   * here describe the same snapshot (no double stat, no missed change between).
   */
  before?: WatchState;
}

/**
 * Block until `target` changes, or the timeout elapses. Polling (not fs.watch)
 * because the signal may be a directory tree or a pattern and a missed event
 * would strand the loop; a 500ms poll is cheap for an unattended run.
 */
export async function waitForWatchChange(
  target: string,
  options: WatchWaitOptions
): Promise<WatchWaitResult> {
  const pollMs = Math.max(20, options.pollMs ?? WATCH_POLL_MS);
  const watchOptions: WatchOptions = options.recursive === true ? { recursive: true } : {};
  const startedAt = Date.now();
  const before = options.before ?? (await watchSignature(target, watchOptions));
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      return {
        changed: false,
        waitedMs: elapsed,
        before,
        after: await watchSignature(target, watchOptions),
      };
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollMs, options.timeoutMs - elapsed))
    );
    const after = await watchSignature(target, watchOptions);
    if (after.signature !== before.signature) {
      return { changed: true, waitedMs: Date.now() - startedAt, before, after };
    }
  }
}

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Killed by `--until-timeout`: no verdict was produced. */
  timedOut?: boolean;
}

/** Runs the check command; a non-zero exit is data, not an exception. */
export async function runLoopCheck(
  until: string,
  cwd: string,
  timeoutMs = DEFAULT_UNTIL_TIMEOUT_MS
): Promise<CheckResult> {
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = windows ? ['/d', '/s', '/c', until] : ['-c', until];
  try {
    const result = await runProcess(command, {
      args,
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      ...(windows ? { windowsVerbatimArguments: true } : {}),
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const processError = error as {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
      timedOut?: boolean;
    };
    return {
      exitCode: typeof processError.exitCode === 'number' ? processError.exitCode : 1,
      stdout: processError.stdout ?? '',
      stderr: processError.stderr ?? processError.message ?? String(error),
      ...(processError.timedOut === true ? { timedOut: true } : {}),
    };
  }
}

function tail(text: string, limit = 4000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

function tailForLedger(text: string, limit = 1200): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

function failureFeedback(check: CheckResult, until: string): string {
  const observed = [check.stdout, check.stderr].filter((part) => part.trim() !== '').join('\n');
  const lines = [
    'The previous attempt did not pass the acceptance check.',
    `Check command exit code: ${check.exitCode}`,
  ];
  if (observed.trim() === '') {
    // Silent checks (`test -f`, `grep -q`) print nothing; without the command
    // the next attempt is blind — it cannot know what was expected.
    lines.push(`The check printed nothing (a silent condition). The check command is: ${until}`);
  } else {
    lines.push('Check output (tail):', '---', tail(observed), '---');
  }
  lines.push(
    'Fix the cause of the failure with the smallest change, then stop. Do not claim success without a passing check.'
  );
  return lines.join('\n');
}

export async function runLoopCommand(
  argv: readonly string[],
  ctx: LoopCommandContext
): Promise<number> {
  const zh = isZhLocale();
  const say = (line: string): void => {
    console.error(line);
  };
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(renderLoopUsage(zh));
    return argv.length === 0 ? 2 : 0;
  }
  let options: LoopOptions;
  try {
    options = parseLoopArgs(argv);
  } catch (error: unknown) {
    console.error(`moss loop: ${error instanceof Error ? error.message : String(error)}`);
    console.error(renderLoopUsage(zh));
    return 2;
  }

  const runIdBase = `loop-${Date.now().toString(36)}`;
  const ledgerPath = path.join(ctx.workspaceDir, '.moss', 'loops', `${runIdBase}.jsonl`);
  const ledgerLabel = path.relative(ctx.workspaceDir, ledgerPath);
  let ledgerBroken = false;
  const appendLedger = (record: LoopStartRecord | LoopAttemptRecord | LoopSummaryRecord): void => {
    if (ledgerBroken) return;
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    } catch (error: unknown) {
      ledgerBroken = true;
      say(
        `[loop] could not write the attempt ledger (${error instanceof Error ? error.message : String(error)}); carrying on without it`
      );
    }
  };
  const changedFiles = async (): Promise<string[] | undefined> => {
    try {
      const result = await runProcess('git', {
        args: ['-C', ctx.workspaceDir, 'status', '--porcelain'],
        cwd: ctx.workspaceDir,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      });
      const files = result.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((file) => file !== '' && !file.startsWith('.moss/'))
        .slice(0, 20);
      return files;
    } catch {
      // Not a git workspace (or git missing): the audit simply omits the list.
      return undefined;
    }
  };
  const loopStartedAt = Date.now();
  // B163: attempts are not separate ledger rows; sum their usage into the loop row.
  const loopUsage = createSessionUsageAccumulator();
  appendLedger({
    type: 'start',
    runId: runIdBase,
    at: new Date(loopStartedAt).toISOString(),
    pid: process.pid,
    until: options.until,
    maxAttempts: options.maxAttempts,
    prompt: options.prompt.slice(0, 500),
    untilTimeoutMs: options.untilTimeoutMs,
  });
  let attempts = 0;
  let pendingWaitMs = 0;
  let lastCheck: CheckResult = { exitCode: 1, stdout: '', stderr: '' };
  let reason: LoopSummaryRecord['reason'] = 'attempts_exhausted';
  // The ledger records what was actually watched: `--watch build --watch-recursive`
  // is `build/**`, and `loop show` should not claim one directory was watched.
  const summaryWatch =
    options.watch !== undefined
      ? watchTargetLabel(options.watch, options.watchRecursive === true)
      : undefined;
  say(`[loop] ledger: ${ledgerLabel}`);

  const finish = async (passed: boolean): Promise<number> => {
    const summary: LoopSummaryRecord = {
      type: 'summary',
      runId: runIdBase,
      at: new Date().toISOString(),
      passed,
      attempts,
      maxAttempts: options.maxAttempts,
      maxDurationMs: options.maxDurationMs,
      totalDurationMs: Date.now() - loopStartedAt,
      reason,
      until: options.until,
      untilTimeoutMs: options.untilTimeoutMs,
      ...(summaryWatch ? { watch: summaryWatch } : {}),
    };
    appendLedger(summary);
    // B129 follow-up: the loop is an autonomous run too; give `moss runs` one
    // row for it (never fatal — the ledger above is the source of truth).
    try {
      const [{ writeRunRecord }, { buildLoopRunRecord }] = await Promise.all([
        import('../core/run-ledger.js'),
        import('./loop-run-record.js'),
      ]);
      await writeRunRecord(
        ctx.workspaceDir,
        buildLoopRunRecord({
          runId: runIdBase,
          passed,
          reason,
          attempts,
          prompt: options.prompt,
          startedAt: loopStartedAt,
          endedAt: Date.now(),
          until: options.until,
          lastCheckExitCode: lastCheck.exitCode,
          ledgerPath: ledgerLabel,
          ...(() => {
            const summary = loopUsage.summary();
            const usage = summary.calls > 0 ? runUsageFromSlices(summary.slices) : undefined;
            return usage ? { usage } : {};
          })(),
        })
      );
    } catch (error) {
      say(
        `[loop] could not write the run ledger (${error instanceof Error ? error.message : String(error)}); carrying on`
      );
    }
    if (passed) {
      console.log(
        zh
          ? `[loop] 通过：第 ${attempts} 轮后 \`${options.until}\` 退出 0`
          : `[loop] passed: \`${options.until}\` exited 0 after attempt ${attempts}`
      );
      console.log(`[loop] ledger: ${ledgerLabel}`);
      return 0;
    }
    const files = await changedFiles();
    const observed = tail([lastCheck.stdout, lastCheck.stderr].filter(Boolean).join('\n'));
    const why =
      reason === 'budget_exhausted'
        ? zh
          ? `墙钟预算 ${options.maxDurationMs}ms 用尽（${attempts} 轮后）`
          : `wall-clock budget ${options.maxDurationMs}ms exhausted after ${attempts} attempt(s)`
        : reason === 'check_timeout'
          ? zh
            ? `检查命令 ${formatLoopDuration(options.untilTimeoutMs)} 内没有结束（挂起），已停止；这不是判定失败，剩余轮次未消耗`
            : `the check did not finish within ${formatLoopDuration(options.untilTimeoutMs)} (--until-timeout); it hung, so the loop stopped instead of burning the remaining attempts`
          : reason === 'watch_timeout'
            ? zh
              ? `等 \`${options.watch ?? ''}\` 变化超时（${options.watchTimeoutMs}ms），已停止而不是烧掉剩余轮次`
              : `no change on \`${options.watch ?? ''}\` within ${options.watchTimeoutMs}ms (--watch-timeout); stopped instead of burning the remaining attempts`
            : zh
              ? `${attempts} 轮后 \`${options.until}\` 仍未通过`
              : `${attempts} attempt(s) and \`${options.until}\` still exited ${lastCheck.exitCode}`;
    const changedLine =
      files && files.length > 0
        ? zh
          ? `\n---\n工作区改动（git status）：${files.join(', ')}`
          : `\n---\nworkspace changes (git status): ${files.join(', ')}`
        : '';
    console.log(
      `[loop] ${zh ? '未通过' : 'not passed'}: ${why}\n---\n${observed}${changedLine}\n---`
    );
    console.log(`[loop] ledger: ${ledgerLabel}`);
    return 1;
  };

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (options.maxDurationMs > 0 && attempt > 1) {
      // The cap is only checked between attempts: an in-flight turn keeps its
      // full budget for the identical reason a hard kill would lose partial work.
      if (Date.now() - loopStartedAt >= options.maxDurationMs) {
        reason = 'budget_exhausted';
        break;
      }
    }
    say(`[loop] attempt ${attempt}/${options.maxAttempts}: running the agent`);
    const message =
      attempt === 1
        ? options.prompt
        : `${options.prompt}\n\n${failureFeedback(lastCheck, options.until)}`;
    const attemptStartedAt = Date.now();
    let agentError: string | undefined;
    try {
      await runOneShotWithCliCancellation(ctx.agent, message, {
        sessionKey: `${runIdBase}-attempt-${attempt}`,
        headless: true,
        cwd: ctx.workspaceDir,
        onAgentEvent: (event) => loopUsage.record(event),
        suppressRunLedger: true,
      });
    } catch (error: unknown) {
      // An agent error is an attempt failure, not a loop abort: the check below
      // is still the only thing that decides, and the next attempt gets a fresh
      // session.
      agentError = error instanceof Error ? error.message : String(error);
      say(`[loop] attempt ${attempt}: agent ended with an error: ${agentError}`);
    }
    const attemptDurationMs = Date.now() - attemptStartedAt;
    const checkStartedAt = Date.now();
    lastCheck = await runLoopCheck(options.until, ctx.workspaceDir, options.untilTimeoutMs);
    const checkDurationMs = Date.now() - checkStartedAt;
    attempts = attempt;
    const passed = lastCheck.exitCode === 0;
    const record: LoopAttemptRecord = {
      type: 'attempt',
      runId: runIdBase,
      attempt,
      at: new Date().toISOString(),
      durationMs: attemptDurationMs,
      sessionKey: `${runIdBase}-attempt-${attempt}`,
      ...(agentError ? { agentError } : {}),
      check: {
        exitCode: lastCheck.exitCode,
        durationMs: checkDurationMs,
        stdout: tailForLedger(lastCheck.stdout),
        stderr: tailForLedger(lastCheck.stderr),
        ...(lastCheck.timedOut ? { timedOut: true } : {}),
      },
      passed,
      ...(pendingWaitMs > 0 ? { waitedMs: pendingWaitMs } : {}),
    };
    pendingWaitMs = 0;
    appendLedger(record);
    say(
      lastCheck.timedOut
        ? `[loop] attempt ${attempt}/${options.maxAttempts}: check did not finish within ${formatLoopDuration(options.untilTimeoutMs)} (--until-timeout)`
        : `[loop] attempt ${attempt}/${options.maxAttempts}: check exit ${lastCheck.exitCode}`
    );
    if (lastCheck.timedOut) {
      reason = 'check_timeout';
      return await finish(false);
    }
    if (passed) {
      reason = 'passed';
      return await finish(true);
    }
    const budgetSpent =
      options.maxDurationMs > 0 && Date.now() - loopStartedAt >= options.maxDurationMs;
    if (attempt < options.maxAttempts && !budgetSpent) {
      say(`[loop] next attempt will receive the check output (exit ${lastCheck.exitCode})`);
      if (options.everyMs > 0) {
        say(`[loop] waiting ${String(options.everyMs)}ms before attempt ${attempt + 1} (--every)`);
        await new Promise<void>((resolve) => setTimeout(resolve, options.everyMs));
        pendingWaitMs += options.everyMs;
      }
      if (options.watch) {
        const watchOptions: WatchOptions =
          options.watchRecursive === true ? { recursive: true } : {};
        // A pattern (or `--watch-recursive`) names what it matched; a literal
        // path keeps its pre-glob line byte for byte.
        const patterned = hasGlobMeta(options.watch) || options.watchRecursive === true;
        const before = await watchSignature(options.watch, watchOptions);
        const detail = patterned ? ` · ${describeWatchState(options.watch, before)}` : '';
        say(
          zh
            ? `[loop] 等待 ${options.watch} 变化，之后开始第 ${String(attempt + 1)} 轮（--watch，超时 ${String(options.watchTimeoutMs)}ms）${detail}`
            : `[loop] waiting for ${options.watch} to change before attempt ${String(attempt + 1)} (--watch, timeout ${String(options.watchTimeoutMs)}ms)${detail}`
        );
        const wait = await waitForWatchChange(options.watch, {
          timeoutMs: options.watchTimeoutMs,
          before,
          ...watchOptions,
        });
        pendingWaitMs += wait.waitedMs;
        if (!wait.changed) {
          reason = 'watch_timeout';
          return await finish(false);
        }
        say(`[loop] external signal changed after ${String(wait.waitedMs)}ms: ${options.watch}`);
        const appeared = wait.before.signature === 'missing:';
        const nowMatched =
          patterned && wait.after.matches !== undefined
            ? zh
              ? `（现在 ${String(wait.after.matches)} 个文件匹配）`
              : ` (now ${String(wait.after.matches)} file${wait.after.matches === 1 ? '' : 's'})`
            : '';
        say(`[loop] ${appeared ? 'path appeared' : 'signature changed'}${nowMatched}`);
      }
    }
  }
  return await finish(false);
}

// --- history (read path) ------------------------------------------------------
//
// B94 wrote `.moss/loops/<runId>.jsonl` for every attempt, but nothing read it:
// an overnight loop left evidence you had to `cat` and parse by hand. Cursor
// shows run history; Claude's task list does the same for subagents. `moss loop
// list|show` is the read path for the same ledger, and stays offline (no agent).

export interface LoopRunSummary {
  runId: string;
  /** Path relative to the workspace, for the report line. */
  ledger: string;
  /** ISO time of the first attempt (or the summary when no attempts exist). */
  startedAt?: string;
  /** ISO time of the summary line; absent for interrupted runs. */
  endedAt?: string;
  passed: boolean;
  /** Summary reason; absent when the loop never wrote its summary. */
  reason?: LoopSummaryRecord['reason'];
  attempts: number;
  maxAttempts?: number;
  totalDurationMs?: number;
  until?: string;
  /** External signal (path / glob / `<dir>/**`) when the run used `--watch`. */
  watch?: string;
  /**
   * `passed`/`failed` from the summary; without one, `running` when the start
   * record's pid is still alive and `interrupted` when it is not (killed,
   * crashed, or a ledger from before start records existed).
   */
  status: 'passed' | 'failed' | 'running' | 'interrupted';
  /** Process id from the start record, for `loop show` / `--json`. */
  pid?: number;
  /** No usable end state: running now or died without a summary. */
  interrupted: boolean;
}

interface LoopLedgerRead {
  attempts: LoopAttemptRecord[];
  start?: LoopStartRecord;
  summary?: LoopSummaryRecord;
  torn: number;
}

export function readLoopLedger(filePath: string): LoopLedgerRead {
  const attempts: LoopAttemptRecord[] = [];
  let start: LoopStartRecord | undefined;
  let summary: LoopSummaryRecord | undefined;
  let torn = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { attempts, torn };
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      const record = parsed as { type?: unknown };
      if (record.type === 'start') start = parsed as LoopStartRecord;
      else if (record.type === 'attempt') attempts.push(parsed as LoopAttemptRecord);
      else if (record.type === 'summary') summary = parsed as LoopSummaryRecord;
    } catch {
      torn += 1;
    }
  }
  return { attempts, ...(start ? { start } : {}), ...(summary ? { summary } : {}), torn };
}

/**
 * Same-host liveness check for a loop pid. EPERM means the process exists but
 * belongs to someone else — still "running", so this is the conservative answer.
 */
export function isLoopProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/** All loop ledgers, newest first (by summary time, then file mtime). */
export function listLoopRuns(workspaceDir: string): LoopRunSummary[] {
  const dir = path.join(workspaceDir, '.moss', 'loops');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const runs: (LoopRunSummary & { sortAt: number })[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const { attempts, start, summary } = readLoopLedger(filePath);
    const runId = summary?.runId ?? start?.runId ?? name.replace(/\.jsonl$/, '');
    if (!summary && attempts.length === 0 && !start) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const sortAt = summary ? Date.parse(summary.at) || mtimeMs : mtimeMs;
    const running = summary === undefined && isLoopProcessAlive(start?.pid);
    const status: LoopRunSummary['status'] = summary
      ? summary.passed
        ? 'passed'
        : 'failed'
      : running
        ? 'running'
        : 'interrupted';
    runs.push({
      runId,
      ledger: path.relative(workspaceDir, filePath),
      ...(attempts[0]?.at ? { startedAt: attempts[0].at } : {}),
      ...(summary?.at ? { endedAt: summary.at } : {}),
      passed: summary?.passed === true,
      ...(summary?.reason ? { reason: summary.reason } : {}),
      attempts: summary?.attempts ?? attempts.length,
      ...(summary?.maxAttempts !== undefined
        ? { maxAttempts: summary.maxAttempts }
        : start?.maxAttempts !== undefined
          ? { maxAttempts: start.maxAttempts }
          : {}),
      ...(summary?.totalDurationMs !== undefined
        ? { totalDurationMs: summary.totalDurationMs }
        : {}),
      ...(summary?.until ? { until: summary.until } : {}),
      ...(start?.until && !summary?.until ? { until: start.until } : {}),
      ...(summary?.watch ? { watch: summary.watch } : {}),
      status,
      ...(start?.pid !== undefined ? { pid: start.pid } : {}),
      interrupted: summary === undefined,
      sortAt,
    });
  }
  return runs
    .sort((left, right) => right.sortAt - left.sortAt)
    .map(({ sortAt: _drop, ...rest }) => rest);
}

/** One ledger removed by `moss loop prune` (or that `--dry-run` would remove). */
export interface LoopPruneEntry {
  runId: string;
  ledger: string;
  bytes: number;
  status: LoopRunSummary['status'];
  /** ISO start time; falls back to the summary time for attempt-less ledgers. */
  startedAt?: string;
}

export interface LoopPruneResult {
  /** Ledgers deleted (or that `--dry-run` would delete), newest first. */
  removed: LoopPruneEntry[];
  /** Finished runs inside the `--keep` window (passed/failed/interrupted). */
  keptFinished: number;
  /** Live runs, which are never pruned regardless of `--keep`. */
  keptRunning: number;
  /** Every ledger seen before pruning. */
  total: number;
  freedBytes: number;
  dryRun: boolean;
  /** Ledgers that could not be deleted; non-empty means the command exits 1. */
  failures: { ledger: string; error: string }[];
}

/**
 * Delete all but the newest `keep` finished ledgers.
 *
 * A run without a summary whose pid is still alive is `running` and is never
 * deleted: pruning a live loop would truncate the record a user is following.
 * Interrupted ledgers (dead pid, or attempts-only ledgers from before start
 * records) count as finished, so killed runs cannot accumulate forever either.
 * `--dry-run` reports the same selection without touching the filesystem.
 */
export function pruneLoopRuns(
  workspaceDir: string,
  options: { keep: number; dryRun?: boolean }
): LoopPruneResult {
  const dryRun = options.dryRun === true;
  const runs = listLoopRuns(workspaceDir);
  const finished = runs.filter((run) => run.status !== 'running');
  const running = runs.length - finished.length;
  const keep = Math.max(0, options.keep);
  const doomed = finished.slice(keep);
  const result: LoopPruneResult = {
    removed: [],
    keptFinished: Math.min(finished.length, keep),
    keptRunning: running,
    total: runs.length,
    freedBytes: 0,
    dryRun,
    failures: [],
  };
  for (const run of doomed) {
    const filePath = path.join(workspaceDir, run.ledger);
    let bytes = 0;
    try {
      bytes = fs.statSync(filePath).size;
    } catch {
      bytes = 0;
    }
    try {
      if (!dryRun) fs.unlinkSync(filePath);
    } catch (error: unknown) {
      result.failures.push({
        ledger: run.ledger,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const startedAt = run.startedAt ?? run.endedAt;
    result.removed.push({
      runId: run.runId,
      ledger: run.ledger,
      bytes,
      status: run.status,
      ...(startedAt ? { startedAt } : {}),
    });
    result.freedBytes += bytes;
  }
  return result;
}

function formatLoopBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `moss loop prune` output: one summary line, then a line per removed ledger. */
export function renderLoopPruneLines(
  result: LoopPruneResult,
  options: { zh?: boolean } = {}
): string[] {
  const zh = options.zh === true;
  const kept = result.keptFinished + result.keptRunning;
  const lines = result.dryRun
    ? [
        zh
          ? `将清理 ${String(result.removed.length)}/${String(result.total)} 个 loop 运行（保留 ${String(kept)} 个）· 可释放 ${formatLoopBytes(result.freedBytes)}（--dry-run，未删除）`
          : `would prune ${String(result.removed.length)} of ${String(result.total)} run(s) (kept ${String(kept)}) · ${formatLoopBytes(result.freedBytes)} reclaimable (--dry-run, nothing deleted)`,
      ]
    : [
        zh
          ? `已清理 ${String(result.removed.length)}/${String(result.total)} 个 loop 运行（保留 ${String(kept)} 个）· 释放 ${formatLoopBytes(result.freedBytes)}`
          : `pruned ${String(result.removed.length)} of ${String(result.total)} run(s) (kept ${String(kept)}) · freed ${formatLoopBytes(result.freedBytes)}`,
      ];
  if (result.removed.length === 0 && result.failures.length === 0) {
    lines[0] = zh
      ? `没有需要清理的 loop 运行（共 ${String(result.total)} 个：已结束 ${String(result.keptFinished)} 个保留，进行中 ${String(result.keptRunning)} 个不动）`
      : `nothing to prune (${String(result.total)} run(s): ${String(result.keptFinished)} finished kept, ${String(result.keptRunning)} running untouched)`;
  }
  for (const entry of result.removed) {
    lines.push(
      `  ${entry.ledger}  ${formatLoopBytes(entry.bytes)}  ${entry.status}${
        entry.startedAt ? `  ${entry.startedAt}` : ''
      }`
    );
  }
  for (const failure of result.failures) {
    lines.push(`  ! ${failure.ledger}: ${failure.error}`);
  }
  return lines;
}

function formatLoopDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
}

function clipLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

function clockOf(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

export type LoopRunStatus = LoopRunSummary['status'];

export interface LoopRunCounts {
  total: number;
  passed: number;
  failed: number;
  running: number;
  interrupted: number;
}

/** Health of the whole ledger, not just the page shown (long runs accumulate). */
export function summarizeLoopRuns(runs: readonly LoopRunSummary[]): LoopRunCounts {
  const counts: LoopRunCounts = {
    total: runs.length,
    passed: 0,
    failed: 0,
    running: 0,
    interrupted: 0,
  };
  for (const run of runs) {
    if (run.status === 'passed') counts.passed += 1;
    else if (run.status === 'running') counts.running += 1;
    else if (run.status === 'interrupted') counts.interrupted += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function renderLoopRunRows(
  runs: readonly LoopRunSummary[],
  options: { zh?: boolean; limit?: number; status?: LoopRunStatus } = {}
): string[] {
  const zh = options.zh === true;
  const limit = options.limit ?? 20;
  const counts = summarizeLoopRuns(runs);
  const scoped = options.status ? runs.filter((run) => run.status === options.status) : runs;
  if (runs.length === 0) {
    return zh
      ? [
          '还没有 loop 运行记录。跑一个：`moss loop --until "<命令>" "<prompt>"`',
          '（每轮的退出码/耗时/检查输出写进 `.moss/loops/<runId>.jsonl`）',
        ]
      : [
          'no loop runs recorded yet (`moss loop --until "<command>" "<prompt>"` writes them)',
          '  each attempt lands in `.moss/loops/<runId>.jsonl`',
        ];
  }
  const header = zh
    ? `loop 运行记录（共 ${String(counts.total)} 次 · 通过 ${String(counts.passed)} · 失败 ${String(counts.failed)} · 进行中 ${String(counts.running)} · 中断 ${String(counts.interrupted)}，最新在前）`
    : `loop runs (${String(counts.total)} total · passed ${String(counts.passed)} · failed ${String(counts.failed)} · running ${String(counts.running)} · interrupted ${String(counts.interrupted)}, newest first)`;
  const statusLabel = options.status
    ? zh
      ? `（仅 ${String(scoped.length)} 条 status=${options.status}）`
      : ` — status ${options.status} (${String(scoped.length)})`
    : '';
  const lines: string[] = [`${header}${statusLabel}`];
  const shown = scoped.slice(0, limit);
  if (shown.length === 0) {
    lines.push(
      zh
        ? `  没有 status=${String(options.status)} 的运行`
        : `  no runs with status ${String(options.status)}`
    );
    return lines;
  }
  for (const run of shown) {
    const outcome =
      run.status === 'passed'
        ? 'pass'
        : run.status === 'running'
          ? 'running'
          : run.status === 'interrupted'
            ? 'interrupted'
            : 'fail';
    const reason =
      run.status === 'running'
        ? zh
          ? `进行中（pid ${String(run.pid)}）`
          : `in progress (pid ${String(run.pid)})`
        : run.status === 'interrupted'
          ? zh
            ? '没有写 summary 且进程已不在（被杀/崩溃/旧账本）'
            : 'no summary and the process is gone (killed, crashed, or a pre-start-record ledger)'
          : run.reason === 'passed'
            ? zh
              ? '检查命令退出 0'
              : 'check exited 0'
            : run.reason === 'budget_exhausted'
              ? zh
                ? '墙钟预算用尽'
                : 'wall-clock budget exhausted'
              : run.reason === 'watch_timeout'
                ? zh
                  ? '外部信号等待超时'
                  : 'watch timed out'
                : run.reason === 'check_timeout'
                  ? zh
                    ? '检查命令超时（挂起）'
                    : 'check timed out (hang)'
                  : zh
                    ? '轮次用尽'
                    : 'attempts exhausted';
    const count = `${String(run.attempts)}/${String(run.maxAttempts ?? run.attempts)}`;
    lines.push(
      `  ${clockOf(run.startedAt)}  ${outcome.padEnd(11)}  ${run.runId.slice(-14).padEnd(14)}  att:${count.padEnd(5)} ${formatLoopDuration(run.totalDurationMs).padStart(7)}  ${clipLine(run.until ?? '', 56)}`
    );
    lines.push(`  ${' '.repeat(10)}  ↳ ${reason}${zh ? '' : ` · ${run.ledger}`}`);
  }
  if (scoped.length > shown.length) {
    lines.push(
      zh
        ? `  …还有 ${String(scoped.length - shown.length)} 条（--limit 调整）`
        : `  …${String(scoped.length - shown.length)} more (raise --limit)`
    );
  }
  return lines;
}

/** One attempt line, shared by `loop show` and `loop follow`. */
export function formatLoopAttemptLine(attempt: LoopAttemptRecord): string {
  const check = attempt.check;
  return `  ${clockOf(attempt.at)}  #${String(attempt.attempt)}${
    attempt.waitedMs && attempt.waitedMs > 0 ? `  wait ${formatLoopDuration(attempt.waitedMs)}` : ''
  }  agent ${formatLoopDuration(attempt.durationMs)}  ${
    check.timedOut === true
      ? `check TIMEOUT (${formatLoopDuration(check.durationMs)})`
      : `check exit ${String(check.exitCode)} (${formatLoopDuration(check.durationMs)})`
  }  ${attempt.passed ? 'PASS' : 'fail'}`;
}

export function formatLoopRunDetail(
  run: LoopRunSummary,
  read: LoopLedgerRead,
  options: { zh?: boolean } = {}
): string[] {
  const zh = options.zh === true;
  const label = (en: string, zhLabel: string): string => (zh ? `${zhLabel}      ` : en.padEnd(10));
  const lines = [
    `${label('RUN', '运行')}${run.runId}`,
    `${label('LEDGER', '账本')}${run.ledger}`,
    `${label('UNTIL', '验收')}${run.until ?? '—'}`,
    ...(run.watch ? [`${label('WATCH', '外部信号')}${run.watch}`] : []),
    ...(run.pid !== undefined ? [`${label('PID', '进程')}${String(run.pid)}`] : []),
    `${label('RESULT', '结果')}${
      run.status === 'passed'
        ? 'passed'
        : run.status === 'running'
          ? zh
            ? 'running（进行中，还没有 summary）'
            : 'running (no summary yet)'
          : run.status === 'interrupted'
            ? zh
              ? 'interrupted（没有 summary 且进程已退出）'
              : 'interrupted (no summary and the process is gone)'
            : `failed${run.reason ? ` · ${run.reason}` : ''}`
    }`,
    `${label('ATTEMPTS', '轮次')}${String(run.attempts)}${run.maxAttempts !== undefined ? `/${String(run.maxAttempts)}` : ''} · ${formatLoopDuration(run.totalDurationMs)}${
      read.summary && read.summary.maxDurationMs > 0
        ? zh
          ? ` · 墙钟上限 ${formatLoopDuration(read.summary.maxDurationMs)}`
          : ` · max ${formatLoopDuration(read.summary.maxDurationMs)}`
        : ''
    }`,
  ];
  if (read.torn > 0) {
    lines.push(
      `${label('NOTE', '备注')}${zh ? `${String(read.torn)} 行无法解析（已跳过）` : `${String(read.torn)} unparseable line(s) skipped`}`
    );
  }
  lines.push('');
  lines.push(zh ? '每轮：' : 'attempts:');
  for (const attempt of read.attempts) {
    const check = attempt.check;
    lines.push(formatLoopAttemptLine(attempt));
    if (attempt.agentError) {
      lines.push(`      ${zh ? '模型错误' : 'agent error'}: ${clipLine(attempt.agentError, 160)}`);
    }
    const observed = clipLine(`${check.stdout}\n${check.stderr}`, 200);
    if (observed !== '') lines.push(`      ${zh ? '检查输出' : 'check output'}: ${observed}`);
  }
  if (read.attempts.length === 0)
    lines.push(zh ? '  （账本里没有 attempt 记录）' : '  (no attempt records)');
  return lines;
}

export interface LoopHistoryContext {
  workspaceDir: string;
  /**
   * `--json` is consumed by the top-level arg parser before dispatch, so the
   * dispatcher forwards `ctx.argv.includes('--json')` here (same trap as
   * `moss task list`). A `--json` left in argv still counts.
   */
  json?: boolean;
}

/** `moss loop list|show` — read the ledger without constructing an agent. */
export interface LoopFollowEvent {
  kind: 'attempt' | 'summary';
  attempt?: LoopAttemptRecord;
  summary?: LoopSummaryRecord;
}

export interface LoopFollowResult {
  runId: string;
  status: LoopRunSummary['status'];
  attempts: LoopAttemptRecord[];
  summary?: LoopSummaryRecord;
  pid?: number;
  totalDurationMs?: number;
}

/**
 * Stream a run's progress by polling its ledger. Deliberately reads the files
 * the loop already writes (no IPC): a follower in another process, or after a
 * restart, sees exactly the audit trail. Emits only events appended after the
 * call starts; already-known attempts are the caller's header material.
 */
export async function followLoopRun(
  workspaceDir: string,
  options: {
    runId?: string;
    pollMs?: number;
    /** Called once with the already-recorded state, before following. */
    onStart?: (run: LoopRunSummary, attempts: readonly LoopAttemptRecord[]) => void;
    onEvent?: (event: LoopFollowEvent) => void;
  } = {}
): Promise<LoopFollowResult | undefined> {
  const pollMs = Math.max(100, options.pollMs ?? 1_000);
  const pick = (): LoopRunSummary | undefined => {
    const runs = listLoopRuns(workspaceDir);
    if (runs.length === 0) return undefined;
    if (options.runId === undefined || options.runId === 'latest') return runs[0];
    return (
      runs.find((run) => run.runId === options.runId) ??
      runs.find((run) => run.runId.startsWith(options.runId!))
    );
  };
  const initial = pick();
  if (!initial) return undefined;
  const runId = initial.runId;
  const ledgerFile = path.join(workspaceDir, initial.ledger);
  const initialRead = readLoopLedger(ledgerFile);
  options.onStart?.(initial, initialRead.attempts);
  let emittedAttempts = initialRead.attempts.length;
  let emittedSummary = initialRead.summary !== undefined;
  if (initialRead.summary) {
    return {
      runId,
      status: initial.status,
      attempts: initialRead.attempts,
      summary: initialRead.summary,
      ...(initial.pid !== undefined ? { pid: initial.pid } : {}),
      ...(initial.totalDurationMs !== undefined
        ? { totalDurationMs: initial.totalDurationMs }
        : {}),
    };
  }
  for (;;) {
    const runs = listLoopRuns(workspaceDir);
    const run = runs.find((candidate) => candidate.runId === runId);
    if (!run) return undefined;
    const read = readLoopLedger(ledgerFile);
    for (const attempt of read.attempts.slice(emittedAttempts)) {
      options.onEvent?.({ kind: 'attempt', attempt });
    }
    emittedAttempts = Math.max(emittedAttempts, read.attempts.length);
    if (read.summary && !emittedSummary) {
      emittedSummary = true;
      options.onEvent?.({ kind: 'summary', summary: read.summary });
    }
    const done = read.summary !== undefined || run.status === 'interrupted';
    if (done) {
      return {
        runId,
        status: run.status,
        attempts: read.attempts,
        ...(read.summary ? { summary: read.summary } : {}),
        ...(run.pid !== undefined ? { pid: run.pid } : {}),
        ...(run.totalDurationMs !== undefined ? { totalDurationMs: run.totalDurationMs } : {}),
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function readLoopHistoryCommand(
  argv: readonly string[],
  ctx: LoopHistoryContext
): Promise<number> {
  const zh = isZhLocale();
  const sub = argv[0];
  const wantJson = ctx.json === true || argv.includes('--json');
  if (sub === 'prune') {
    let keep = DEFAULT_LOOP_KEEP;
    let dryRun = false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--json') continue;
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--keep' || arg.startsWith('--keep=')) {
        let raw: string;
        try {
          raw = readValue(argv, i, '--keep');
        } catch {
          console.error('moss loop prune: --keep needs a value (e.g. --keep 20)');
          return 2;
        }
        if (!arg.includes('=')) i += 1;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error('moss loop prune: --keep must be a positive integer');
          return 2;
        }
        keep = parsed;
        continue;
      }
      console.error(`moss loop prune: unknown argument ${arg}`);
      return 2;
    }
    const result = pruneLoopRuns(ctx.workspaceDir, { keep, dryRun });
    if (wantJson) {
      console.log(JSON.stringify(result.removed, null, 2));
    } else {
      for (const line of renderLoopPruneLines(result, { zh })) console.log(line);
    }
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.error(`moss loop prune: ${failure.ledger}: ${failure.error}`);
      }
      return 1;
    }
    return 0;
  }
  if (sub === 'list') {
    let limit = 20;
    let status: LoopRunStatus | undefined;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--json') continue;
      if (arg === '--status' || arg.startsWith('--status=')) {
        const raw = readValue(argv, i, '--status');
        if (!arg.includes('=')) i += 1;
        const normalized = raw === 'fail' ? 'failed' : raw;
        if (!['passed', 'failed', 'running', 'interrupted'].includes(normalized)) {
          console.error(
            'moss loop list: --status must be one of passed|failed|running|interrupted'
          );
          return 2;
        }
        status = normalized as LoopRunStatus;
        continue;
      }
      if (arg === '--limit' || arg.startsWith('--limit=')) {
        const raw = readValue(argv, i, '--limit');
        if (!arg.includes('=')) i += 1;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error('moss loop list: --limit must be a positive integer');
          return 2;
        }
        limit = parsed;
        continue;
      }
      console.error(`moss loop list: unknown argument ${arg}`);
      return 2;
    }
    const runs = listLoopRuns(ctx.workspaceDir);
    const scoped = status ? runs.filter((run) => run.status === status) : runs;
    if (wantJson) {
      console.log(JSON.stringify(scoped.slice(0, limit), null, 2));
      return 0;
    }
    for (const line of renderLoopRunRows(runs, { zh, limit, ...(status ? { status } : {}) })) {
      console.log(line);
    }
    return 0;
  }
  if (sub === 'follow') {
    let intervalMs = 1_000;
    let target = 'latest';
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--json') {
        console.error('moss loop follow: --json is not supported (it streams lines)');
        return 2;
      }
      if (arg === '--interval' || arg.startsWith('--interval=')) {
        const raw = readValue(argv, i, '--interval');
        if (!arg.includes('=')) i += 1;
        intervalMs = parseLoopDuration(raw, '--interval');
        if (intervalMs < 100) {
          console.error('moss loop follow: --interval must be at least 100ms');
          return 2;
        }
        continue;
      }
      if (arg.startsWith('-')) {
        console.error(`moss loop follow: unknown argument ${arg}`);
        return 2;
      }
      target = arg;
    }
    const started = await followLoopRun(ctx.workspaceDir, {
      runId: target,
      pollMs: intervalMs,
      onStart: (run, attempts) => {
        console.log(
          zh
            ? `[loop] 跟随 ${run.runId}${run.pid !== undefined ? `（pid ${String(run.pid)}）` : ''}，已有 ${String(attempts.length)} 轮；Ctrl+C 停止跟随（不会停掉 loop）`
            : `[loop] following ${run.runId}${run.pid !== undefined ? ` (pid ${String(run.pid)})` : ''} — ${String(attempts.length)} attempt(s) so far; Ctrl+C stops following (not the loop)`
        );
        for (const attempt of attempts) console.log(formatLoopAttemptLine(attempt));
      },
      onEvent: (event) => {
        if (event.kind === 'attempt' && event.attempt) {
          console.log(formatLoopAttemptLine(event.attempt));
        } else if (event.kind === 'summary' && event.summary) {
          console.log(
            zh
              ? `[loop] 结束：${event.summary.passed ? 'passed' : 'failed'} · ${String(event.summary.attempts)} 轮 · ${formatLoopDuration(event.summary.totalDurationMs)} · reason=${event.summary.reason}`
              : `[loop] finished: ${event.summary.passed ? 'passed' : 'failed'} · ${String(event.summary.attempts)} attempt(s) · ${formatLoopDuration(event.summary.totalDurationMs)} · reason=${event.summary.reason}`
          );
        }
      },
    });
    if (!started) {
      console.error(
        zh
          ? `没有可跟随的 loop 运行（${target}）。用 \`moss loop list\` 看 id`
          : `nothing to follow (${target}); see \`moss loop list\` for ids`
      );
      return 1;
    }
    if (started.status === 'interrupted') {
      console.error(
        zh
          ? `[loop] ${started.runId} 已中断：进程不在且没有 summary（被杀/崩溃）`
          : `[loop] ${started.runId} was interrupted: the process is gone and no summary exists (killed or crashed)`
      );
      return 1;
    }
    const passed = started.summary?.passed === true;
    console.log(
      zh
        ? `[loop] ${started.runId} ${passed ? '通过' : '未通过'}：${String(started.attempts.length)} 轮 · ${formatLoopDuration(started.totalDurationMs)}`
        : `[loop] ${started.runId} ${passed ? 'passed' : 'did not pass'}: ${String(started.attempts.length)} attempt(s) · ${formatLoopDuration(started.totalDurationMs)}`
    );
    return passed ? 0 : 1;
  }
  if (sub !== 'show') return 2;
  const requested = argv.slice(1).find((arg) => !arg.startsWith('--')) ?? 'latest';
  const runs = listLoopRuns(ctx.workspaceDir);
  if (runs.length === 0) {
    console.error(
      zh
        ? '没有 loop 运行记录。先跑：moss loop --until "<命令>" "<prompt>"'
        : 'no loop runs recorded yet. Start one: moss loop --until "<command>" "<prompt>"'
    );
    return 1;
  }
  const run =
    requested === 'latest'
      ? runs[0]
      : (runs.find((candidate) => candidate.runId === requested) ??
        runs.find((candidate) => candidate.runId.startsWith(requested)));
  if (!run) {
    console.error(
      zh
        ? `找不到 run id ${requested}（用 \`moss loop list\` 看可用的 id）`
        : `no loop run matches ${requested} (see \`moss loop list\`)`
    );
    return 1;
  }
  const read = readLoopLedger(path.join(ctx.workspaceDir, run.ledger));
  if (wantJson) {
    const records: unknown[] = [...read.attempts, ...(read.summary ? [read.summary] : [])];
    console.log(JSON.stringify(records, null, 2));
    return run.passed ? 0 : 1;
  }
  for (const line of formatLoopRunDetail(run, read, { zh })) console.log(line);
  return run.passed ? 0 : 1;
}
