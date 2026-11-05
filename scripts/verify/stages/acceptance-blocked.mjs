/** Acceptance harness failures block the task instead of burning repairs (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'acceptance-blocked',
  requires: ['build'],
  description: 'missing/timed-out acceptance commands block with a reason (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/acceptance-blocked.mjs');
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
