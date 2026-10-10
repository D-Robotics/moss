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
 * virtualenv. Entries only the login shell adds are appended afterwards
 * (see mergeAcceptancePath), so profile-installed tools still resolve.
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

const LOGIN_PATH_MARKER = '@@moss-login-path@@';
const LOGIN_SHELLS = /(^|\/)(bash|zsh|sh|ksh|dash)$/;
let loginPathPromise: Promise<string> | undefined;

/**
 * PATH that the user's login shell sets (profile lines such as nvm, pyenv,
 * asdf, Homebrew shellenv). Resolved once per process; '' when unavailable.
 * `MOSS_ACCEPT_LOGIN_PATH=0` turns the lookup off.
 */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform === 'win32' || env.MOSS_ACCEPT_LOGIN_PATH === '0')
    return Promise.resolve('');
  loginPathPromise ??= (async () => {
    const shell = env.SHELL && LOGIN_SHELLS.test(env.SHELL) ? env.SHELL : 'bash';
    try {
      const res = await runProcess(shell, {
        args: ['-lc', `printf '${LOGIN_PATH_MARKER}%s${LOGIN_PATH_MARKER}' "$PATH"`],
        timeout: 3000,
      });
      const m = res.stdout.match(new RegExp(`${LOGIN_PATH_MARKER}(.*?)${LOGIN_PATH_MARKER}`));
      return m?.[1] ?? '';
    } catch {
      return '';
    }
  })();
  return loginPathPromise;
}

/**
 * Inherited PATH first, in its own order (an activated virtualenv stays in
 * front). Login-shell entries that are missing are appended, so a tool that
 * only the profile puts on PATH is still found when moss was started from a
 * GUI or IDE with a minimal PATH.
 */
export function mergeAcceptancePath(inherited: string | undefined, login: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...(inherited ?? '').split(':'), ...login.split(':')]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(':');
}

async function acceptanceEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.PATH = mergeAcceptancePath(process.env.PATH, await loginShellPath());
  return env;
}

export async function runAcceptanceCommand(
  spec: AcceptanceSpec,
  signal?: AbortSignal
): Promise<AcceptanceResult> {
  const endedAt = Date.now();
  const shell = acceptanceShell(spec.command);
  const env = process.platform === 'win32' ? undefined : await acceptanceEnv();
  try {
    const res = await runProcess(shell.cmd, {
      ...(env ? { env } : {}),
      args: shell.args,
      timeout: spec.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      signal,
      ...(spec.workspaceDir ? { cwd: spec.workspaceDir } : {}),
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
