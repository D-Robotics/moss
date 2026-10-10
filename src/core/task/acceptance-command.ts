/**
 * Exit-code acceptance command. The task engine's command verdict runs this
 * and treats exit 0 as pass. The output tail is the failure evidence.
 */
import { errorMessage } from '../../errors.js';
import { runProcess } from '../../utils/run-process.js';

export interface AcceptanceSpec {
  /** Shell command that must exit 0 for the goal to be complete. */
  command: string;
  timeoutMs?: number;
  /** Task workspace. The command runs here, not in the process cwd. */
  workspaceDir?: string;
}

export interface AcceptanceResult {
  passed: boolean;
  exitCode: number;
  /** Tail of combined stdout/stderr. */
  tail: string;
  timedOut: boolean;
  endedAt: number;
}

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 5 * 60_000;

/**
 * Shell invocation for an acceptance command.
 *
 * On Windows, Node's default spawn quoting escapes embedded `"` as `\"`.
 * `cmd.exe /s /c` does not treat that backslash as an escape, so the quote
 * characters become part of the filename (`Cannot find module 'D:\repo\"D:\repo\script.mjs"'`).
 * `child_process.exec` avoids this by wrapping the command in one extra pair of
 * quotes and setting `windowsVerbatimArguments`: `/s` strips exactly that
 * wrapper and cmd parses the original command.
 *
 * POSIX uses `bash -c` so the PATH moss inherited stays in place. A login
 * shell sources the profile and replaces PATH, which drops an activated
 * virtualenv.
 */
export function acceptanceShell(
  command: string,
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32') {
    return {
      cmd: process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { cmd: 'bash', args: ['-c', command] };
}

export async function runAcceptanceCommand(
  spec: AcceptanceSpec,
  signal?: AbortSignal
): Promise<AcceptanceResult> {
  return runAcceptanceCommandInWorkspace(spec, signal);
}

/** Internal host-cwd-independent execution; the public runner stays compatible. */
export async function runAcceptanceCommandInWorkspace(
  spec: AcceptanceSpec,
  signal?: AbortSignal,
  workspaceDir: string | undefined = spec.workspaceDir
): Promise<AcceptanceResult> {
  const endedAt = Date.now();
  const shell = acceptanceShell(spec.command);
  try {
    const res = await runProcess(shell.cmd, {
      args: shell.args,
      timeout: spec.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      signal,
      ...(workspaceDir ? { cwd: workspaceDir } : {}),
      ...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
