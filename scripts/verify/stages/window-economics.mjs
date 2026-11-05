/**
 * B65: honest small-window prompt budget (never above the configured window) and
 * a proactive compaction threshold that fits inside it.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'window-economics',
  requires: ['build'],
  description: 'Small-window prompt budget never exceeds the model window',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/window-economics.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[window-economics] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
