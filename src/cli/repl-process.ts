import { spawnProcess, type ChildProcess } from '../utils/run-process.js';
import { sanitizeTextForTerminal } from './terminal-text.js';

export const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;

/**
 * Marker a truncated capture starts with. It is an ordinary output line, so it
 * travels through the transcript's `⎿` / diff grammar like any other line.
 */
const TRUNCATION_NOTICE_RE = /^… output truncated · (\d+) chars? \((\d+) lines?\) hidden\n/;

function truncationNotice(chars: number, lines: number): string {
  return `… output truncated · ${chars} ${chars === 1 ? 'char' : 'chars'} (${lines} ${
    lines === 1 ? 'line' : 'lines'
  }) hidden\n`;
}

/**
 * Raw tail chopper: keeps the newest `limit` characters, drops the head.
 * Prefer `appendLimitedAnnounced` for anything a human reads — this primitive
 * is silent about what it dropped, which is only acceptable when the caller
 * already guarantees the loss is impossible or reported elsewhere.
 */
export function appendLimited(
  current: string,
  chunk: string,
  limit = LOCAL_SHELL_OUTPUT_LIMIT
): string {
  const next = `${current}${chunk}`;
  if (next.length <= limit) return next;
  return next.slice(-limit);
}

/**
 * `appendLimited` that never truncates silently.
 *
 * Two properties matter for output integrity (adversarial acceptance D-4):
 *  - the cut lands on a LINE boundary whenever one is available, so the first
 *    visible line is a whole line. A mid-line fragment as the first line is what
 *    made a head-truncated `/diff` look like the diff really started there
 *    (and made the transcript gutter number it as line 1);
 *  - the retained output is prefixed with `… output truncated · N chars (M
 *    lines) hidden`, and the counters accumulate across chunks, so a reader can
 *    tell the capture is partial instead of trusting shifted numbering.
 */
export function appendLimitedAnnounced(
  current: string,
  chunk: string,
  limit = LOCAL_SHELL_OUTPUT_LIMIT
): string {
  const match = TRUNCATION_NOTICE_RE.exec(current);
  const notice = match?.[0] ?? '';
  const body = match ? current.slice(notice.length) : current;
  const combined = `${body}${chunk}`;
  if (notice.length + combined.length <= limit) return `${notice}${combined}`;

  const hiddenChars = match ? Number(match[1]) : 0;
  const hiddenLines = match ? Number(match[2]) : 0;

  // The notice itself needs room, and its length depends on the counters, so
  // budget with the current counters plus a little headroom for wider numbers.
  const reserve = truncationNotice(hiddenChars, hiddenLines).length + 8;
  const budget = limit - reserve;
  if (budget < 1) {
    // A limit smaller than the notice cannot announce anything; keep the newest
    // output verbatim rather than emitting a longer string than the caller
    // allowed. (LOCAL_SHELL_OUTPUT_LIMIT is 40 000, so this is a test-only edge.)
    return appendLimited('', combined, limit);
  }
  let kept = appendLimited('', combined, budget);
  const boundary = combined.indexOf('\n', combined.length - kept.length);
  if (boundary >= 0 && boundary + 1 < combined.length) kept = combined.slice(boundary + 1);

  const dropped = combined.slice(0, combined.length - kept.length);
  const nextNotice = truncationNotice(
    hiddenChars + dropped.length,
    hiddenLines + (dropped.match(/\n/g) ?? []).length
  );
  if (nextNotice.length + kept.length > limit) {
    kept = appendLimited('', kept, Math.max(1, limit - nextNotice.length));
  }
  return `${nextNotice}${kept}`;
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
      // Sanitize for safety (ANSI, control characters, binary blobs) but NEVER
      // inject spaces: stdout is shown verbatim and wrapped by terminal CELLS at
      // render time. `breakLongTokens` used to split every 24 characters of a
      // space-free run that was not "copy sensitive" — and a leading `+`/`-`/
      // quote defeats that guard, so exactly the tokens a diff is made of
      // (`-import ... '../dist/core/task-runti me/runtime.js';`) were mangled
      // (adversarial acceptance D-4).
      const text = sanitizeTextForTerminal(chunk.toString('utf8'), { breakLongTokens: false });
      output = appendLimitedAnnounced(output, text);
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
