/** Long-run parity: `/rewind` checkpoints survive a session restart. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'checkpoint-persist',
  requires: ['build'],
  description:
    'checkpoint metadata persists across store instances; 100-item retention prunes backups',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/checkpoint-persist.mjs');
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
