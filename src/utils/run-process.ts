import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';

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
  if (args === undefined) return spawn(command);
  if (isSpawnOptions(args)) return spawn(command, withCanonicalCwd(args));
  if (options === undefined) return spawn(command, args);
  return spawn(command, args, withCanonicalCwd(options));
}

/**
 * Shared synchronous boundary for process-exit cleanup and short capability
 * probes. Callers must supply a finite timeout for probes.
 */
export const runProcessSync: typeof spawnSync = spawnSync;

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
}

export class ProcessError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  readonly timedOut: boolean;

  constructor(exitCode: number, stdout: string, stderr: string, timedOut = false) {
    super(`Process exited with code ${exitCode}`);
    this.name = 'ProcessError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

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

    const child = spawn(cmd, opts.args, spawnOpts);

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
      if (killed) return;
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
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
      const text = chunk.toString();
      if (stdout.length < (opts.maxBuffer ?? DEFAULT_MAX_BUFFER)) {
        stdout += text;
      }
      // Live streaming: forward each chunk to the caller's callback so the TUI
      // can show incremental output for long-running commands.
      opts.onStdoutChunk?.(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < (opts.maxBuffer ?? DEFAULT_MAX_BUFFER)) {
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

    child.on('close', (code) => {
      cleanup();
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
      } else {
        reject(new ProcessError(exitCode, stdout, stderr, timedOut));
      }
    });
  });
}
