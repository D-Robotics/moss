/**
 * Goal loop — acceptance-driven autonomous execution.
 *
 * In goal mode the loop only counts as complete when an external acceptance
 * command (the compiled "Done") exits 0. The acceptance verdict is
 * authoritative: it outranks the model's self-judgement, so a failing command
 * vetoes a DONE claim and redirects the next iteration to the failure
 * evidence. Pure helpers here; the scheduling lives in loop-scheduler.ts.
 */
import { runProcess } from '../../utils/run-process.js';
import { errorMessage } from '../../errors.js';

export interface AcceptanceSpec {
  /** Shell command that must exit 0 for the goal to be complete. */
  command: string;
  timeoutMs?: number;
}

export interface AcceptanceResult {
  passed: boolean;
  exitCode: number;
  /** Tail of combined stdout/stderr — injected into the next iteration. */
  tail: string;
  timedOut: boolean;
  endedAt: number;
}

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 5 * 60_000;

export async function runAcceptanceCommand(
  spec: AcceptanceSpec,
  signal?: AbortSignal
): Promise<AcceptanceResult> {
  const endedAt = Date.now();
  const shell =
    process.platform === 'win32'
      ? { cmd: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', spec.command] }
      : { cmd: 'bash', args: ['-lc', spec.command] };
  try {
    const res = await runProcess(shell.cmd, {
      args: shell.args,
      timeout: spec.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      signal,
    });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    return {
      passed: res.exitCode === 0,
      exitCode: res.exitCode,
      tail: combined.slice(-2000),
      timedOut: false,
      endedAt,
    };
  } catch (err) {
    const exitCode =
      typeof (err as { exitCode?: number }).exitCode === 'number'
        ? (err as { exitCode: number }).exitCode
        : 1;
    const combined = `${(err as { stdout?: string }).stdout ?? ''}\n${
      (err as { stderr?: string }).stderr ?? errorMessage(err)
    }`.trim();
    return {
      passed: false,
      exitCode,
      tail: combined.slice(-2000),
      timedOut: (err as { timedOut?: boolean }).timedOut === true,
      endedAt,
    };
  }
}

export function buildAcceptanceFailurePrompt(goal: string, result: AcceptanceResult): string {
  return [
    `The acceptance command for the goal still fails (exit ${result.exitCode}${
      result.timedOut ? ', timed out' : ''
    }).`,
    'Fix the underlying cause — do not work around, disable, or edit the acceptance command or its fixtures.',
    '',
    'Last acceptance output (tail):',
    result.tail || '(no output)',
    '',
    `Original goal: ${goal}`,
  ].join('\n');
}

export interface ParsedGoalCommand {
  goal: string;
  acceptance?: { command: string };
}

/**
 * Parse a `/goal <goal text> [--accept "<verification command>"]` line.
 * Returns null for a malformed line (empty goal, or --accept without a
 * command).
 */
export function parseGoalCommandLine(line: string): ParsedGoalCommand | null {
  const raw = line.trim();
  if (!raw) return null;
  const idx = raw.search(/(^|\s)--accept(\s+|=|$)/);
  if (idx === -1) return { goal: raw };
  const goal = raw.slice(0, idx).trim();
  if (!goal) return null;
  let rest = raw
    .slice(idx)
    .replace(/^\s*--accept(\s+|=|$)/, '')
    .trim();
  if (!rest) return null;
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    rest = rest.slice(1, -1);
  }
  rest = rest.trim();
  if (!rest) return null;
  return { goal, acceptance: { command: rest } };
}
