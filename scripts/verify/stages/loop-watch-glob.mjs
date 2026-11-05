/** `moss loop --watch` glob + `--watch-recursive` (offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-watch-glob',
  requires: ['build'],
  description:
    'loop --watch accepts globs / --watch-recursive and keeps literal paths unchanged (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/loop-watch-glob.mjs');
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
