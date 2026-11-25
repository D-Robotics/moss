import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'harness-injection',
  requires: ['build'],
  description: 'No harness turn from regex on prose; provider-fact recovery kept',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/harness-injection.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (result.timedOut) return { ok: false, detail: 'harness-injection probe timed out' };
    if (result.status !== 0)
      return {
        ok: false,
        detail: 'harness-injection probe exited ' + (result.status ?? result.signal),
      };
    return { ok: true };
  },
};
