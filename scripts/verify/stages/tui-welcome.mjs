/**
 * TUI first-screen parity stage (offline, B137).
 *
 * Skips (PASS) only when python3/pty is unavailable, like the other PTY stages.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'tui-welcome',
  requires: ['build'],
  description: 'TUI first frame shows the last run and its resume command (REPL parity)',
  async run(context) {
    const python = await captureProcess('python3', ['--version'], { timeoutMs: 10_000 });
    if (python.status !== 0) {
      console.log('[tui-welcome] skipping: python3/pty is unavailable');
      return { ok: true };
    }
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tui-welcome.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.timedOut) {
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    }
    if (result.status !== 0) {
      const lastLine = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}${lastLine ? `: ${lastLine}` : ''}`,
      };
    }
    console.log(`[tui-welcome] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
