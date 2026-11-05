/** L1 skill catalog budget scales with the model window (~1% of it). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-catalog-budget',
  requires: ['build'],
  description:
    'The skills catalog spends ~1% of the model window (8k ceiling, 800-char floor) instead of a fixed 8k',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/skill-catalog-budget.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 120_000,
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
