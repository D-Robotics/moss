import fs from 'node:fs';
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import {
  NO_CWD_EXE_SEARCH_ENV,
  noTrustedPath,
  envPathKey,
  envShebangCommand,
  isBareCommand,
  resolveExecutable,
  sanitizeChildPathEnv,
  trustedSearchDirs,
} from './resolve-executable.js';

export type { ChildProcess, SpawnOptions } from 'node:child_process';

/**
 * macOS `posix_spawn` can fail with `ENOENT` when `cwd` still contains a
 * symlink (`/tmp` → `/private/tmp`, `/var` → `/private/var`, and the
 * `TMPDIR` `/var/folders/...` prefix). The directory exists; the spawn does
 * not. Callers keep passing the path they have. The boundary resolves it.
 */
function canonicalCwd(cwd: SpawnOptions['cwd']): SpawnOptions['cwd'] {
  if (typeof cwd !== 'string' || cwd.length === 0) return cwd;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function isSpawnOptions(value: readonly string[] | SpawnOptions): value is SpawnOptions {
  return !Array.isArray(value);
}

function withCanonicalCwd(options: SpawnOptions): SpawnOptions {
  if (options.cwd === undefined) return options;
  const cwd = canonicalCwd(options.cwd);
  if (cwd === options.cwd) return options;
  return { ...options, cwd };
}

/**
 * Shared low-level spawn boundary for interactive or persistent children whose
 * lifecycle is owned by the caller. Bounded commands should use {@link runProcess}.
 */
export function spawnProcess(command: string, options?: SpawnOptions): ChildProcess;
export function spawnProcess(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
): ChildProcess;
export function spawnProcess(
  command: string,
  args?: readonly string[] | SpawnOptions,
  options?: SpawnOptions
): ChildProcess {
  if (args === undefined || isSpawnOptions(args)) {
    const target = spawnTarget(command, withCanonicalCwd(args ?? {}));
    return target.args
      ? spawn(target.command, target.args, target.options)
      : spawn(target.command, target.options);
  }
  const target = spawnTarget(command, withCanonicalCwd(options ?? {}));
  return spawn(target.command, [...(target.args ?? []), ...args], target.options);
}

let parentNoCwdSearch = false;
/**
 * O158: libuv's Windows spawn consults the *parent* env for
 * `NoDefaultCurrentDirectoryInExePath` before it searches cwd. Set it once so
 * a name that slips past {@link resolveExecutable} still is not taken from
 * the workspace; children inherit it.
 */
function ensureParentNoCwdSearch(): void {
  if (parentNoCwdSearch || process.platform !== 'win32') return;
  parentNoCwdSearch = true;
  if (process.env[NO_CWD_EXE_SEARCH_ENV] === undefined) process.env[NO_CWD_EXE_SEARCH_ENV] = '1';
}

type SpawnLikeOptions = Pick<SpawnOptions, 'cwd' | 'env' | 'shell'>;

/**
 * O158: the single place every Moss child is resolved. A bare program name
 * becomes an absolute path from trusted PATH entries only (see
 * resolve-executable.ts); the child env loses empty/relative PATH entries and
 * gets `NoDefaultCurrentDirectoryInExePath=1` on Windows. A name that cannot
 * be resolved is spawned bare with PATH limited to the trusted entries (or a
 * nonexistent absolute dir when none is left, never `""`), so it fails with
 * ENOENT instead of running a workspace file.
 * `shell: true` on Windows gets an absolute cmd.exe.
 * @internal exported for tests
 */
export function spawnTarget<O extends SpawnLikeOptions>(
  command: string,
  options: O
): { command: string; options: O; args?: string[] } {
  ensureParentNoCwdSearch();
  const platform = process.platform;
  const baseEnv = options.env ?? process.env;
  let env = sanitizeChildPathEnv(baseEnv, platform);
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  let resolvedCommand = command;
  let prefixArgs: string[] | undefined;
  let shell = options.shell;
  if (shell) {
    if (platform === 'win32' && shell === true) {
      const comspec = baseEnv.ComSpec ?? baseEnv.COMSPEC ?? process.env.ComSpec ?? 'cmd.exe';
      shell = resolveExecutable(comspec, { env: baseEnv, cwd }) ?? comspec;
    } else if (typeof shell === 'string' && isBareCommand(shell, platform)) {
      shell = resolveExecutable(shell, { env: baseEnv, cwd }) ?? shell;
    }
  } else if (isBareCommand(command, platform)) {
    const found = resolveExecutable(command, { env: baseEnv, cwd });
    if (found) {
      resolvedCommand = found;
      // O158 (O1): `#!/usr/bin/env node` scripts get an absolute interpreter.
      const viaShebang = envShebangCommand(found, { env: baseEnv, cwd });
      if (viaShebang) {
        resolvedCommand = viaShebang[0];
        prefixArgs = viaShebang.slice(1);
      }
    } else {
      const key = envPathKey(env, platform) ?? 'PATH';
      const trusted = trustedSearchDirs({ env: baseEnv, cwd });
      // O158 F1: never PATH="" — libuv/execvp read an empty PATH as the cwd.
      env = {
        ...env,
        [key]:
          trusted.length > 0
            ? trusted.join(platform === 'win32' ? ';' : ':')
            : noTrustedPath(platform),
      };
    }
  }
  if (env === baseEnv && shell === options.shell && resolvedCommand === command) {
    return { command, options };
  }
  return {
    command: resolvedCommand,
    ...(prefixArgs ? { args: prefixArgs } : {}),
    options: {
      ...options,
      ...(env === baseEnv ? {} : { env }),
      ...(shell === options.shell ? {} : { shell }),
    },
  };
}

/**
 * Shared synchronous boundary for process-exit cleanup and short capability
 * probes. Callers must supply a finite timeout for probes.
 */
export const runProcessSync = ((
  command: string,
  args?: readonly string[] | SpawnSyncOptions,
  options?: SpawnSyncOptions
) => {
  if (args === undefined || !Array.isArray(args)) {
    const target = spawnTarget(command, (args as SpawnSyncOptions | undefined) ?? {});
    return target.args
      ? spawnSync(target.command, target.args, target.options)
      : spawnSync(target.command, target.options);
  }
  const target = spawnTarget(command, options ?? {});
  return spawnSync(target.command, [...(target.args ?? []), ...args], target.options);
}) as typeof spawnSync;

/** Configure the active Windows console for UTF-8 output. */
export function configureWindowsUtf8Console(): void {
  runProcessSync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', 'chcp 65001'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 2_000,
  });
}

export interface RunProcessOptions {
  args: string[];
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
  /** Optional string to write to the child's stdin. */
  stdin?: string;
  /** Optional callback for live stdout chunks — enables incremental output
   *  display (e.g. the TUI shows a long-running command's output as it
   *  arrives, not just at the end). */
  onStdoutChunk?: (chunk: string) => void;
  /** Windows only. Pass argv through to the child without Node's extra
   *  quoting. Required for `cmd.exe /s /c` so embedded quotes stay quotes. */
  windowsVerbatimArguments?: boolean;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * O162: the stream produced more than `maxBuffer` bytes, so the text above
   * is incomplete. Callers that parse a verdict from it must not trust it.
   */
  stdoutOverflow?: boolean;
  stderrOverflow?: boolean;
}

export class ProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  readonly timedOut: boolean;
  readonly timeoutMs: number | undefined;
  /** O162: see RunProcessResult.stdoutOverflow / stderrOverflow. */
  stdoutOverflow = false;
  stderrOverflow = false;

  constructor(
    exitCode: number | null,
    stdout: string,
    stderr: string,
    timedOut = false,
    timeoutMs?: number,
    signal: NodeJS.Signals | null = null
  ) {
    super(
      timedOut && timeoutMs !== undefined && timeoutMs > 0
        ? `timed out after ${timeoutMs}ms`
        : signal
          ? `killed by ${signal}`
          : exitCode === null
            ? 'Process failed'
            : `Process exited with code ${exitCode}`
    );
    this.name = 'ProcessError';
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
    this.timeoutMs = timeoutMs;
  }
}

/** Default per-stream capture limit (bytes) for runProcess. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function runProcess(cmd: string, opts: RunProcessOptions): Promise<RunProcessResult> {
  if (opts.signal?.aborted) {
    return Promise.reject(new ProcessError(1, '', 'Process aborted before start'));
  }

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: opts.env,
      cwd: canonicalCwd(opts.cwd),
      detached: process.platform !== 'win32',
      ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    };

    const target = spawnTarget(cmd, spawnOpts);
    const child = spawn(target.command, [...(target.args ?? []), ...opts.args], target.options);

    let stdout = '';
    let stderr = '';
    // O162: bytes seen per stream, so a caller can tell the buffer was cut.
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
      if (killed) return;
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          runProcessSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 2_000,
          });
          child.kill(signal);
        } else if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };

    if (opts.timeout && opts.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeout);
    }

    const onAbort = () => kill();
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      const text = chunk.toString();
      if (stdout.length < maxBuffer) {
        stdout += text;
      }
      // Live streaming: forward each chunk to the caller's callback so the TUI
      // can show incremental output for long-running commands.
      opts.onStdoutChunk?.(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < maxBuffer) {
        stderr += chunk.toString();
      }
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
          stderr += `Failed to write process stdin: ${err.message}\n`;
        }
      });
      child.stdin.end(opts.stdin);
    }

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code, signal) => {
      cleanup();
      const stdoutOverflow = stdoutBytes > maxBuffer;
      const stderrOverflow = stderrBytes > maxBuffer;
      if (code === 0 && !signal) {
        resolve({
          stdout,
          stderr,
          exitCode: 0,
          ...(stdoutOverflow ? { stdoutOverflow } : {}),
          ...(stderrOverflow ? { stderrOverflow } : {}),
        });
      } else {
        const err = new ProcessError(code, stdout, stderr, timedOut, opts.timeout, signal);
        err.stdoutOverflow = stdoutOverflow;
        err.stderrOverflow = stderrOverflow;
        reject(err);
      }
    });
  });
}
