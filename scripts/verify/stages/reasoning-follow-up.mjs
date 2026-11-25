import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'reasoning-follow-up',
  requires: ['build'],
  description: 'Reasoning level reaches the wire on the call after a tool result',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/reasoning-follow-up.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (result.timedOut) return { ok: false, detail: 'reasoning-follow-up probe timed out' };
    if (result.status !== 0)
      return {
        ok: false,
        detail: 'reasoning-follow-up probe exited ' + (result.status ?? result.signal),
      };
    return { ok: true };
  },
};
