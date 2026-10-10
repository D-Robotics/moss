/**
 * Shell for the model-facing `exec` tool.
 *
 * Windows switches to PowerShell 7 (`pwsh`) only. Windows PowerShell 5.1 has
 * no `&&`, and the exec description tells the model to chain with `&&`.
 * User hooks, the status line, and acceptance commands stay on cmd.exe.
 */
import { runProcessSync } from './run-process.js';

export type HostShellKind = 'sh' | 'pwsh' | 'cmd';

export interface ResolvedHostShell {
  kind: HostShellKind;
  executable: string;
  description: string;
  argsFor(command: string): string[];
}

export interface HostShellProbe {
  platform?: NodeJS.Platform;
  comspec?: string;
  lookup?: (name: string) => string | null;
  /** Major version of a `pwsh` executable. Null means it is not PowerShell 7+. */
  pwshMajor?: (executable: string) => number | null;
}

const POWERSHELL_DESCRIPTION =
  'On Windows the local shell is PowerShell 7 (pwsh). Chain with &&. Unix-only utilities (for example uname) are unavailable.';

const CMD_DESCRIPTION =
  'On Windows the local shell is cmd.exe. Chain with &&. Unix-only utilities (for example uname) are unavailable.';

let cached: ResolvedHostShell | undefined;

function lookupOnPath(name: string): string | null {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runProcessSync(finder, [name], {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function pwshMajorVersion(executable: string): number | null {
  const result = runProcessSync(
    executable,
    ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true }
  );
  if (result.status !== 0) return null;
  const major = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  return Number.isInteger(major) ? major : null;
}

function resolveUncached(probe: HostShellProbe): ResolvedHostShell {
  const platform = probe.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      kind: 'sh',
      executable: '/bin/sh',
      description: '',
      argsFor: (command) => ['-c', command],
    };
  }
  const lookup = probe.lookup ?? lookupOnPath;
  const majorOf = probe.pwshMajor ?? pwshMajorVersion;
  const pwsh = lookup('pwsh');
  if (pwsh && (majorOf(pwsh) ?? 0) >= 7) {
    return {
      kind: 'pwsh',
      executable: pwsh,
      description: POWERSHELL_DESCRIPTION,
      argsFor: (command) => ['-NoProfile', '-Command', command],
    };
  }
  const comspec = probe.comspec || process.env.COMSPEC || 'cmd.exe';
  return {
    kind: 'cmd',
    executable: comspec,
    description: CMD_DESCRIPTION,
    argsFor: (command) => ['/c', command],
  };
}

/** Resolve the exec shell. The default probe is cached; injected probes are not. */
export function resolveHostShell(probe: HostShellProbe = {}): ResolvedHostShell {
  const injected =
    probe.platform !== undefined ||
    probe.comspec !== undefined ||
    probe.lookup !== undefined ||
    probe.pwshMajor !== undefined;
  if (!injected && cached) return cached;
  const resolved = resolveUncached(probe);
  if (!injected) cached = resolved;
  return resolved;
}

export function hostShellInvocation(
  command: string,
  shell: ResolvedHostShell = resolveHostShell()
): { executable: string; args: string[] } {
  return { executable: shell.executable, args: shell.argsFor(command) };
}
