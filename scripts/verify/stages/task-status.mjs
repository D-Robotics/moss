/** `task list` health header + `--status` filter (B111, offline). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'task-status',
  requires: ['build'],
  description: 'task list counts every outcome and filters with --status (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/task-status.mjs');
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
