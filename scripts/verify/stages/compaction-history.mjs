/**
 * Compaction look-back pointer probe (build dependency): the checkpoint must
 * point at the durable transcript deterministically, and only when the store
 * has one — asserted against dist/ with a stub summarizer, no model call.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'compaction-history',
  requires: ['build'],
  description: 'Compaction checkpoint points back at the durable transcript (# HISTORICAL)',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/compaction-history.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[compaction-history] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
