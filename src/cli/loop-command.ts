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
import path from 'node:path';

import { runOneShotWithCliCancellation } from './run-cancellation.js';
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
  /** External signal: wait for this path to change before the next attempt. */
  watch?: string;
  /** How long `--watch` waits for a change before ending the loop (0 = default 10m). */
  watchTimeoutMs: number;
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
  check: { exitCode: number; durationMs: number; stdout: string; stderr: string };
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
  reason: 'passed' | 'attempts_exhausted' | 'budget_exhausted' | 'watch_timeout';
  until: string;
  /** The external signal path, when `--watch` was used. */
  watch?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000;
const WATCH_POLL_MS = 500;
const MAX_ATTEMPTS_CAP = 20;
const CHECK_TIMEOUT_MS = 10 * 60_000;

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
      '  --watch <路径>：失败后等这个文件/目录变化再跑下一轮（外部信号唤醒，如 CI 产物落地）。',
      '  --watch-timeout 10m：等不到变化就收工（summary reason=watch_timeout，不烧剩余轮次）。',
      '  每轮的退出码/耗时/检查输出尾部/改动会写进 .moss/loops/<runId>.jsonl（启动时打印路径）。',
      '  moss loop list [--limit N] [--json]：历史运行（最新在前，离线读账本）。',
      '  moss loop show [<run_id>|latest] [--json]：某次运行的每轮明细与检查输出。',
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
    '  --watch <path> waits for that file/directory to change before the next attempt',
    '  (an external signal such as a CI artifact); --watch-timeout 10m gives up and ends the',
    '  loop with summary reason watch_timeout instead of burning the remaining attempts.',
    '  --every and --watch can be combined: the fixed delay runs, then the watch wait.',
    '  The ledger for every attempt (exit code, duration, check output tails) is',
    '  written to .moss/loops/<runId>.jsonl and the path is printed at startup.',
    '  moss loop list [--limit N] [--json] reads the run history (offline, newest first).',
    "  moss loop show [<run_id>|latest] [--json] prints one run's attempts and check tails.",
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
  let watchTimeoutMs = 0;
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
    if (arg === '--watch' || arg.startsWith('--watch=')) {
      const raw = readValue(argv, i, '--watch');
      if (!arg.includes('=')) i += 1;
      watch = raw.trim();
      if (watch === '') throw new Error('--watch needs a file or directory path');
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
  return {
    prompt,
    until,
    maxAttempts,
    everyMs,
    maxDurationMs,
    ...(watch !== undefined ? { watch } : {}),
    watchTimeoutMs: watchTimeoutMs > 0 ? watchTimeoutMs : DEFAULT_WATCH_TIMEOUT_MS,
  };
}

export interface WatchState {
  /** Stable textual signature; `missing:` when the path does not exist. */
  signature: string;
  exists: boolean;
}

/**
 * Cheap signature of a file or a directory tree (name + size + mtime, bounded).
 * The loop only needs "did anything change", not a full content diff.
 */
export async function watchSignature(target: string): Promise<WatchState> {
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory())
      return { signature: `file:${String(stat.size)}:${String(stat.mtimeMs)}`, exists: true };
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
 * Block until `target` changes, or the timeout elapses. Polling (not fs.watch)
 * because the signal may be a directory tree and a missed event would strand
 * the loop; a 500ms poll is cheap for an unattended run.
 */
export async function waitForWatchChange(
  target: string,
  options: { timeoutMs: number; pollMs?: number }
): Promise<WatchWaitResult> {
  const pollMs = Math.max(20, options.pollMs ?? WATCH_POLL_MS);
  const startedAt = Date.now();
  const before = await watchSignature(target);
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      return { changed: false, waitedMs: elapsed, before, after: await watchSignature(target) };
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollMs, options.timeoutMs - elapsed))
    );
    const after = await watchSignature(target);
    if (after.signature !== before.signature) {
      return { changed: true, waitedMs: Date.now() - startedAt, before, after };
    }
  }
}

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the check command; a non-zero exit is data, not an exception. */
export async function runLoopCheck(until: string, cwd: string): Promise<CheckResult> {
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = windows ? ['/d', '/s', '/c', until] : ['-c', until];
  try {
    const result = await runProcess(command, {
      args,
      cwd,
      timeout: CHECK_TIMEOUT_MS,
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
    };
    return {
      exitCode: typeof processError.exitCode === 'number' ? processError.exitCode : 1,
      stdout: processError.stdout ?? '',
      stderr: processError.stderr ?? processError.message ?? String(error),
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
  appendLedger({
    type: 'start',
    runId: runIdBase,
    at: new Date(loopStartedAt).toISOString(),
    pid: process.pid,
    until: options.until,
    maxAttempts: options.maxAttempts,
    prompt: options.prompt.slice(0, 500),
  });
  let attempts = 0;
  let pendingWaitMs = 0;
  let lastCheck: CheckResult = { exitCode: 1, stdout: '', stderr: '' };
  let reason: LoopSummaryRecord['reason'] = 'attempts_exhausted';
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
      ...(options.watch ? { watch: options.watch } : {}),
    };
    appendLedger(summary);
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
    lastCheck = await runLoopCheck(options.until, ctx.workspaceDir);
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
      },
      passed,
      ...(pendingWaitMs > 0 ? { waitedMs: pendingWaitMs } : {}),
    };
    pendingWaitMs = 0;
    appendLedger(record);
    say(`[loop] attempt ${attempt}/${options.maxAttempts}: check exit ${lastCheck.exitCode}`);
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
        say(
          `[loop] waiting for ${options.watch} to change before attempt ${attempt + 1} (--watch, timeout ${String(options.watchTimeoutMs)}ms)`
        );
        const wait = await waitForWatchChange(options.watch, {
          timeoutMs: options.watchTimeoutMs,
        });
        pendingWaitMs += wait.waitedMs;
        if (!wait.changed) {
          reason = 'watch_timeout';
          return await finish(false);
        }
        say(`[loop] external signal changed after ${String(wait.waitedMs)}ms: ${options.watch}`);
        say(
          `[loop] ${wait.before.signature === 'missing:' ? 'path appeared' : 'signature changed'}`
        );
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
  /** External signal path when the run used `--watch`. */
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

function readLoopLedger(filePath: string): LoopLedgerRead {
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

export function renderLoopRunRows(
  runs: readonly LoopRunSummary[],
  options: { zh?: boolean; limit?: number } = {}
): string[] {
  const zh = options.zh === true;
  const limit = options.limit ?? 20;
  const shown = runs.slice(0, limit);
  if (shown.length === 0) {
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
  const lines: string[] = [
    zh
      ? `loop 运行记录（${String(runs.length)} 条，最新在前）`
      : `loop runs (${String(runs.length)}, newest first)`,
  ];
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
                : zh
                  ? '轮次用尽'
                  : 'attempts exhausted';
    const count = `${String(run.attempts)}/${String(run.maxAttempts ?? run.attempts)}`;
    lines.push(
      `  ${clockOf(run.startedAt)}  ${outcome.padEnd(11)}  ${run.runId.slice(-14).padEnd(14)}  att:${count.padEnd(5)} ${formatLoopDuration(run.totalDurationMs).padStart(7)}  ${clipLine(run.until ?? '', 56)}`
    );
    lines.push(`  ${' '.repeat(10)}  ↳ ${reason}${zh ? '' : ` · ${run.ledger}`}`);
  }
  if (runs.length > shown.length) {
    lines.push(
      zh
        ? `  …还有 ${String(runs.length - shown.length)} 条（--limit 调整）`
        : `  …${String(runs.length - shown.length)} more (raise --limit)`
    );
  }
  return lines;
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
    lines.push(
      `  ${clockOf(attempt.at)}  #${String(attempt.attempt)}${
        attempt.waitedMs && attempt.waitedMs > 0
          ? `  wait ${formatLoopDuration(attempt.waitedMs)}`
          : ''
      }  agent ${formatLoopDuration(attempt.durationMs)}  check exit ${String(check.exitCode)} (${formatLoopDuration(check.durationMs)})  ${attempt.passed ? 'PASS' : 'fail'}`
    );
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
export async function readLoopHistoryCommand(
  argv: readonly string[],
  ctx: LoopHistoryContext
): Promise<number> {
  const zh = isZhLocale();
  const sub = argv[0];
  const wantJson = ctx.json === true || argv.includes('--json');
  if (sub === 'list') {
    let limit = 20;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--json') continue;
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
    if (wantJson) {
      console.log(JSON.stringify(runs.slice(0, limit), null, 2));
      return 0;
    }
    for (const line of renderLoopRunRows(runs, { zh, limit })) console.log(line);
    return 0;
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
