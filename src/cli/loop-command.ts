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
  reason: 'passed' | 'attempts_exhausted' | 'budget_exhausted';
  until: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
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
      '  每轮的退出码/耗时/检查输出尾部/改动会写进 .moss/loops/<runId>.jsonl（启动时打印路径）。',
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
    '  The ledger for every attempt (exit code, duration, check output tails) is',
    '  written to .moss/loops/<runId>.jsonl and the path is printed at startup.',
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
    rest.push(arg);
  }
  const prompt = rest.join(' ').trim();
  if (!until) throw new Error('--until is required: the loop must end on a command, not on prose');
  if (!prompt) throw new Error('the prompt is required');
  return { prompt, until, maxAttempts, everyMs, maxDurationMs };
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
  const appendLedger = (record: LoopAttemptRecord | LoopSummaryRecord): void => {
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
  let attempts = 0;
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
    };
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
      }
    }
  }
  return await finish(false);
}
