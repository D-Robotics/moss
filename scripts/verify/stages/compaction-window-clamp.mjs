/**
 * B13 root cause (build dependency): small context windows were given the 20k
 * default reserve, which made compaction trigger on every turn and asked the
 * summarizer for 4096 output tokens on a 5k window.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'compaction-window-clamp',
  requires: ['build'],
  description: 'Small context windows clamp compaction reserve and summary budget',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/compaction-window-clamp.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[compaction-window-clamp] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
