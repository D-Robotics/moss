/** Cross-run goal rollup: `.moss/goals.jsonl` + `moss task list` projection (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'goal-runs',
  requires: ['build'],
  description: 'goal-run ledger round-trips and the task list table renders (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/goal-runs.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 30_000,
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
