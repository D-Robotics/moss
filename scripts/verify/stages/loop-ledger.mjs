/** Closed-loop parity: `moss loop` keeps an auditable attempt ledger + wall-clock cap. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-ledger',
  requires: ['build'],
  description: 'loop attempt ledger, honest summary reasons and --max-duration (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/loop-ledger.mjs');
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
