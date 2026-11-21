import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'steering-intent',
  requires: ['build'],
  description: 'Live steering invalidates stale tools and verified goals',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/steering-intent.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (result.timedOut) return { ok: false, detail: 'steering probe timed out' };
    return result.status === 0
      ? { ok: true }
      : { ok: false, detail: 'steering probe exited ' + (result.status ?? result.signal) };
  },
};
