/** Completion gate reads the structured review record, not just prose (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'review-verdict',
  requires: ['build'],
  description: 'completion gate reads .moss/review.jsonl verdict/findings (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/review-verdict.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 60_000,
    });
    if (result.timedOut || result.status !== 0) {
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}\n${result.stdout}${result.stderr}`,
      };
    }
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
