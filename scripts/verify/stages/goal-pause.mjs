/** /goal parity: Ctrl+C pauses a goal run (notice wording + no-resume branch). */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'goal-pause',
  requires: ['build'],
  description: 'paused-goal notice names the task and both resume paths (offline)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/goal-pause.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 30_000,
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
