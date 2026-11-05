/** Claude parity: `--add-dir` widens the file-tool write boundary for one run. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'add-dir',
  requires: ['build'],
  description: '--add-dir resolution + sandbox containment + prompt disclosure',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/add-dir.mjs');
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
