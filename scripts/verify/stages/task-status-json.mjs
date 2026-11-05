/** `task status --json` machine-readable twin (B120, offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'task-status-json',
  requires: ['build'],
  description: 'task status --json prints one object and keeps the human view (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/task-status-json.mjs');
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
