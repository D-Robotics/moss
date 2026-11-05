/** A hung `--until` check stops the loop with check_timeout (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-check-timeout',
  requires: ['build'],
  description: 'a hung --until check stops the loop with reason check_timeout (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/loop-check-timeout.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 90_000,
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
