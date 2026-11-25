import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'command-extras',
  requires: ['build'],
  description:
    'Session commands print what they should: /thinking, /session, /usage, /changelog, /debug',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/command-extras.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (result.timedOut) return { ok: false, detail: 'command-extras probe timed out' };
    if (result.status !== 0)
      return {
        ok: false,
        detail: 'command-extras probe exited ' + (result.status ?? result.signal),
      };
    return { ok: true };
  },
};
