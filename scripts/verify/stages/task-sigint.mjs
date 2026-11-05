/**
 * Headless Ctrl+C stage (B121).
 *
 * Real end-to-end SIGINT against a local never-answering provider: the first
 * Ctrl+C must pause the task (aborted event + `/goal resume` hint) and exit 130,
 * and the pause must be durable and resumable.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-sigint',
  requires: ['build'],
  description: 'headless Ctrl+C pauses the task and exits 130',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-sigint.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 180_000 }
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
    console.log(`[task-sigint] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
