/**
 * Independent review pipeline probe (build dependency): the reviewer output
 * contract, the verdict rule, the diff collector and the `.moss/review.jsonl`
 * persistence are asserted deterministically — no model call.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'review-pipeline',
  requires: ['build'],
  description: 'Independent review: parser, verdict rule, diff collector, review.jsonl contract',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/review-pipeline.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[review-pipeline] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
