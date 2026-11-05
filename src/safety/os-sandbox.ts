/**
 * D14 opt-in OS sandbox for `exec` (design: docs/design/os-sandbox.md).
 *
 * This is NOT the default and NOT a replacement for approval. When the user
 * opts in (`permissions.osSandbox: true` or `MOSS_OS_SANDBOX=1`) and the
 * effective safety mode is `workspace-write` / `read-only`, local shell
 * commands run inside a kernel boundary:
 *
 * - macOS: `sandbox-exec` with a profile that allows reads and process
 *   execution, denies network, allows writes only under the workspace root
 *   (with `.git/hooks` / `.git/config` write-denied) and refuses /tmp writes.
 * - Linux: `bwrap` (`--ro-bind / /`, workspace bound read-write, user/pid/net
 *   namespaces unshared). No bundled binary; a missing bwrap is a refusal.
 * - Windows: no kernel backend in this slice → exec is refused, naming WSL2.
 *
 * A missing or rejected backend is a failed command, never a silent
 * unsandboxed retry (Codex's rule; see the design doc's failure table).
 */
import fs from 'node:fs';
import path from 'node:path';

export type SandboxBackend = 'seatbelt' | 'bubblewrap';

export interface SandboxPlan {
  command: string;
  args: string[];
  backend: SandboxBackend;
  /** Human-facing one-liner for tool results / startup notices. */
  label: string;
}

export type SandboxResolution = { plan: SandboxPlan } | { refusal: string } | { disabled: true };

export interface SandboxRequest {
  command: string;
  args: readonly string[];
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** The opt-in is a resolved boolean: config key OR env, never one silently. */
export function osSandboxRequested(
  configFlag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (configFlag === true) return true;
  const raw = (env.MOSS_OS_SANDBOX ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const CONFIG_KEY_HINT =
  'permissions.osSandbox (true) or MOSS_OS_SANDBOX=1; unset it to run a normal shell';

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** PATH lookup without spawning a shell: first executable match wins. */
function findOnPath(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PATH ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function realWorkspace(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

/** Escape a path for a seatbelt string literal (backslash and double quote). */
function seatbeltPath(filePath: string): string {
  return filePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * `deny default` + explicit allows. Reads stay broad (toolchains need /usr,
 * /Library, /System, node_modules); writes are the workspace only; /tmp stays
 * read-only on purpose (design doc: Codex/Claude temp writable is the hole
 * people hit with `printf > /tmp`); the network is denied in v1.
 */
export function seatbeltProfile(workspaceRoot: string): string {
  const ws = seatbeltPath(realWorkspace(workspaceRoot));
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(allow file-write*',
    `  (subpath "${ws}")`,
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty"))',
    '(deny file-write*',
    `  (subpath "${ws}/.git/hooks")`,
    `  (literal "${ws}/.git/config"))`,
    '(deny network*)',
    '',
  ].join('\n');
}

function seatbeltPlan(request: SandboxRequest, env: NodeJS.ProcessEnv): SandboxResolution {
  const override = env.MOSS_SANDBOX_EXEC_PATH?.trim();
  const binary = override || '/usr/bin/sandbox-exec';
  if (!isExecutableFile(binary)) {
    return {
      refusal:
        `OS sandbox is on, but sandbox-exec was not found at ${binary}. ` +
        'exec was NOT run unsandboxed. Fix the path with MOSS_SANDBOX_EXEC_PATH or turn the opt-in off: ' +
        CONFIG_KEY_HINT +
        '.',
    };
  }
  const profile = seatbeltProfile(request.workspaceRoot);
  return {
    plan: {
      command: binary,
      args: ['-p', profile, request.command, ...request.args],
      backend: 'seatbelt',
      label: 'seatbelt (macOS sandbox-exec): writes only under the workspace, no network',
    },
  };
}

function bubblewrapPlan(request: SandboxRequest, env: NodeJS.ProcessEnv): SandboxResolution {
  const binary = findOnPath('bwrap', env);
  if (!binary) {
    return {
      refusal:
        'OS sandbox is on, but bubblewrap (bwrap) is not on PATH. exec was NOT run unsandboxed. ' +
        'Install bubblewrap (e.g. apt install bubblewrap) or turn the opt-in off: ' +
        CONFIG_KEY_HINT +
        '.',
    };
  }
  const ws = realWorkspace(request.workspaceRoot);
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--bind',
    ws,
    ws,
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--die-with-parent',
    '--',
    request.command,
    ...request.args,
  ];
  return {
    plan: {
      command: binary,
      args,
      backend: 'bubblewrap',
      label: 'bubblewrap: writes only under the workspace, no network',
    },
  };
}

/**
 * Resolve the spawn spec for one shell command. `disabled` means the caller
 * must run exactly what it would have run without this module.
 */
export function buildOsSandboxPlan(request: SandboxRequest): SandboxResolution {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  if (platform === 'darwin') return seatbeltPlan(request, env);
  if (platform === 'linux') return bubblewrapPlan(request, env);
  if (platform === 'win32') {
    return {
      refusal:
        'OS sandbox is on, but Moss has no kernel sandbox backend on native Windows in this slice. ' +
        'exec was NOT run. Use WSL2 (the Linux bwrap path) or turn the opt-in off: ' +
        CONFIG_KEY_HINT +
        '.',
    };
  }
  return {
    refusal:
      `OS sandbox is on, but platform "${platform}" has no backend in this slice. ` +
      'exec was NOT run. Turn the opt-in off: ' +
      CONFIG_KEY_HINT +
      '.',
  };
}
