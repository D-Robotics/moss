/**
 * Compaction summary structure probe (backlog B03): the nine-section contract
 * must be machine-checked, with exactly one corrective retry, never a silent
 * truncation. Deterministic — stubbed summarizer over dist/, no model call.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'compaction-summary',
  requires: ['build'],
  description: 'Compaction summary structure is validated with one bounded retry',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/compaction-summary.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[compaction-summary] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
