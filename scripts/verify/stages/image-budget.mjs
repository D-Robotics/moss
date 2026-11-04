/**
 * Historical image budget probe (backlog B01): provider requests carry only the
 * newest images; the session transcript keeps every observed image.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'image-budget',
  requires: ['build'],
  description: 'Only the newest images are sent to the provider; the session keeps all',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/image-budget.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[image-budget] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
