import { spawnProcess, type ChildProcess } from '../utils/run-process.js';
import { sanitizeRenderableText } from './terminal-text.js';

export const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;

export function appendLimited(
  current: string,
  chunk: string,
  limit = LOCAL_SHELL_OUTPUT_LIMIT
): string {
  const next = `${current}${chunk}`;
  if (next.length <= limit) return next;
  return next.slice(-limit);
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
      return;
    } catch {
      // Fall through to the direct child kill.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The process may have exited before the group kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Process may have already exited.
  }
}

export function runLocalShellCommand(options: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}): Promise<{ output: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Local shell command aborted before start'));
      return;
    }
    let output = '';
    let settled = false;
    const child = spawnProcess(options.command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, MOSS_TUI_LOCAL_SHELL: '1' },
    });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const push = (chunk: Buffer) => {
      const text = sanitizeRenderableText(chunk.toString('utf8'));
      output = appendLimited(output, text);
      options.onChunk?.(text);
    };
    const onAbort = () => {
      killProcessTree(child);
      settle(() => reject(new Error('Local shell command aborted')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      settle(() => resolve({ output, exitCode: code, signal }));
    });
  });
}
