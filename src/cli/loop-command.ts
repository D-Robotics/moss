/**
 * `moss loop --until <cmd> "<prompt>"` — the local closed loop.
 *
 * Cursor's `/loop` and autopilot run the agent, check the result, and feed the
 * failure back until the check passes or the budget is spent. This is the local,
 * scriptable equivalent: each attempt is a fresh headless one-shot (no shared
 * conversation state), then the user's own command decides. The loop never
 * declares success on its own — exit 0 comes only from the check command.
 */
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
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 20;
const CHECK_TIMEOUT_MS = 10 * 60_000;

export function renderLoopUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss loop --until "<命令>" [--max N] "<prompt>"',
      '',
      '  每轮：用 prompt 跑一次全新的 headless 会话 → 执行 --until 命令。',
      '  命令退出 0 即成功（exit 0）；失败会把输出尾部喂回下一轮（最多 N 次，默认 3）。',
      '  --until 不能省略：循环的成败只由你的命令判定，不由模型自述判定。',
      '',
      '示例：',
      '  moss loop --until "npm run verify" "修复 verify 的失败项，最小改动"',
      '  moss loop --until "moss review check" --max 2 "按评审意见修复并复评"',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss loop --until "<command>" [--max N] "<prompt>"',
    '',
    '  Each attempt runs one fresh headless session with the prompt, then runs the',
    '  --until command. Exit 0 of that command means success (loop exits 0); on',
    '  failure the output tail is fed into the next attempt (default 3 attempts).',
    '  --until is required: only your command decides, never the model prose.',
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

export function parseLoopArgs(argv: readonly string[]): LoopOptions {
  const rest: string[] = [];
  let until: string | undefined;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
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
    rest.push(arg);
  }
  const prompt = rest.join(' ').trim();
  if (!until) throw new Error('--until is required: the loop must end on a command, not on prose');
  if (!prompt) throw new Error('the prompt is required');
  return { prompt, until, maxAttempts };
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
  let lastCheck: CheckResult = { exitCode: 1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    say(`[loop] attempt ${attempt}/${options.maxAttempts}: running the agent`);
    const message =
      attempt === 1
        ? options.prompt
        : `${options.prompt}\n\n${failureFeedback(lastCheck, options.until)}`;
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
      say(
        `[loop] attempt ${attempt}: agent ended with an error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    lastCheck = await runLoopCheck(options.until, ctx.workspaceDir);
    say(`[loop] attempt ${attempt}/${options.maxAttempts}: check exit ${lastCheck.exitCode}`);
    if (lastCheck.exitCode === 0) {
      console.log(
        zh
          ? `[loop] 通过：第 ${attempt} 轮后 \`${options.until}\` 退出 0`
          : `[loop] passed: \`${options.until}\` exited 0 after attempt ${attempt}`
      );
      return 0;
    }
    if (attempt < options.maxAttempts) {
      say(`[loop] next attempt will receive the check output (exit ${lastCheck.exitCode})`);
    }
  }
  const observed = tail([lastCheck.stdout, lastCheck.stderr].filter(Boolean).join('\n'));
  console.log(
    zh
      ? `[loop] 未通过：${options.maxAttempts} 轮后 \`${options.until}\` 仍退出 ${lastCheck.exitCode}\n---\n${observed}\n---`
      : `[loop] not passed: \`${options.until}\` still exited ${lastCheck.exitCode} after ${options.maxAttempts} attempts\n---\n${observed}\n---`
  );
  return 1;
}
