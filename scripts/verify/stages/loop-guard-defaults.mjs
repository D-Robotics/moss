import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-guard-defaults',
  requires: ['build'],
  description: 'Tool-loop-guard limits are opt-in; fresh-news dedupe and probe budgets stay on',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/loop-guard-defaults.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (result.timedOut) return { ok: false, detail: 'loop-guard-defaults probe timed out' };
    if (result.status !== 0)
      return {
        ok: false,
        detail: 'loop-guard-defaults probe exited ' + (result.status ?? result.signal),
      };
    return { ok: true };
  },
};
