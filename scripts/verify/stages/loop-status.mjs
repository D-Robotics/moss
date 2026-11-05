/** `moss loop list` in-flight vs interrupted status (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-status',
  requires: ['build'],
  description: 'loop history distinguishes running from killed via start-record pid (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/loop-status.mjs');
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
