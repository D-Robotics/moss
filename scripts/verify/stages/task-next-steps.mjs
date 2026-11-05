/**
 * Run-summary next-step stage (B119).
 *
 * Locks that every non-pass task summary prints the engine reason and the
 * exact resume command (and that a pass prints none of it).
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-next-steps',
  requires: ['build'],
  description: 'non-pass task summaries name the reason and the retry command',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-next-steps.mjs')],
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
    console.log(`[task-next-steps] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
