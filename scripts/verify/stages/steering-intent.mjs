import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'steering-intent',
  requires: ['build'],
  description: 'Jev steering, log filtering and completion correction',
  async run(context) {
    for (const name of ['steering-intent', 'jev-runtime']) {
      const result = await runProcess(
        process.execPath,
        [path.join(context.root, 'scripts/verify', name + '.mjs')],
        { cwd: context.root, timeoutMs: 20_000 }
      );
      if (result.timedOut) return { ok: false, detail: name + ' probe timed out' };
      if (result.status !== 0)
        return { ok: false, detail: name + ' probe exited ' + (result.status ?? result.signal) };
    }
    return { ok: true };
  },
};
