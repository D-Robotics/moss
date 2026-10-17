/**
 * Shell for the model-facing `exec` tool.
 *
 * Windows switches to PowerShell 7 (`pwsh`) only. Windows PowerShell 5.1 has
 * no `&&`, and the exec description tells the model to chain with `&&`.
 * User hooks, the status line, and acceptance commands stay on cmd.exe.
 *
 * O153 — finding pwsh, and what a `;` chain captures:
 * - pwsh is looked up on PATH in-process with PATHEXT (default
 *   `.COM;.EXE;.BAT;.CMD` when the env has none), then via `where.exe` with the
 *   same default. Before O153 only `where.exe` was used, and it finds nothing
 *   when PATHEXT is missing from the env (IDE/service/CI launchers, the -p
 *   specs). Moss then silently fell back to cmd.exe, where `;` is not a
 *   separator: `node -e 1; ls R` ran only `node` with `1;`, `ls`, `R` as its
 *   argv. That gave exit 0 and `(no output)`. The second half never ran.
 * - The pwsh child also gets that default PATHEXT when the env has none
 *   (`hostShellChildEnv`); otherwise pwsh itself cannot resolve `node`, `git`.
 * - Under pwsh (`-NoProfile -NonInteractive -Command`, stdout/stderr piped),
 *   every `;` statement runs and its success/error streams are captured,
 *   including after a native EXE such as `node` (windows-latest, pwsh 7.6).
 * - Known limits of a pwsh `;` chain: the process exit reflects only the last
 *   statement. It is 1 when that statement failed, and a native exit code such
 *   as 3 becomes 1. A failed earlier statement does not make the exit non-zero;
 *   its error text still lands on stderr. Chain with `&&` to stop at the first
 *   failure.
 * - The cmd.exe fallback (no pwsh 7 on PATH) keeps cmd semantics: `;` is
 *   not a separator there.
 */
import fs from 'node:fs';
import path from 'node:path';
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
/** Default-probe entries. Importing a tool module must not increment this. */
let defaultProbeCount = 0;

/** @internal How many times the default (spawning) probe has run. */
export function hostShellDefaultProbeCount(): number {
  return defaultProbeCount;
}

/** Windows' own default when PATHEXT is unset (cmd.exe uses the same list). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * O153: resolve `name` on a Windows PATH without depending on PATHEXT being in
 * the environment. Pure apart from `isFile`, so it is testable on any OS.
 * @internal exported for tests
 */
export function findOnWindowsPath(
  name: string,
  env: { PATH?: string; PATHEXT?: string },
  isFile: (candidate: string) => boolean = defaultIsFile
): string | null {
  const exts = (env.PATHEXT?.trim() ? env.PATHEXT : DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  const hasExt = exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const raw of (env.PATH ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.win32.join(dir, name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * O153: env for a pwsh exec child. pwsh resolves bare native commands (`node`,
 * `git`, …) through PATHEXT; when the env has none it finds nothing and every
 * such statement fails with "is not recognized". Give the child Windows'
 * default PATHEXT in that case. Other shells and envs that already carry
 * PATHEXT (any case) are returned unchanged.
 */
export function hostShellChildEnv<T extends Record<string, string | undefined>>(
  env: T,
  shell: Pick<ResolvedHostShell, 'kind'>
): T {
  // [CI-only revert of the O153 fix]: child env always unchanged.
  if (shell.kind !== 'pwsh' || Object.keys(env).length >= 0) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  if (key !== undefined && env[key]?.trim()) return env;
  const next: Record<string, string | undefined> = { ...env };
  if (key !== undefined) delete next[key];
  next.PATHEXT = DEFAULT_PATHEXT;
  return next as T;
}

function defaultIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function lookupOnPath(name: string): string | null {
  // [CI-only revert of the O153 fix]: where.exe only, no PATHEXT default.
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
      argsFor: (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  const comspec = probe.comspec || process.env.COMSPEC || 'cmd.exe';
  return {
    kind: 'cmd',
    executable: comspec,
    description: CMD_DESCRIPTION,
    argsFor: (command) => ['/d', '/s', '/c', `"${command}"`],
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
  if (!injected) defaultProbeCount += 1;
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
