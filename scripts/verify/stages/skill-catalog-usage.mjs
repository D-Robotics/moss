/**
 * Usage-aware skill catalog probe (backlog B10): recently loaded skills rank
 * first inside their scope, so a budget cut drops the least-recently-used entry.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-catalog-usage',
  requires: ['build'],
  description: 'Skill catalog ranks recently used skills first inside a scope',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/skill-catalog-usage.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[skill-catalog-usage] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
