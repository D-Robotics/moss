/**
 * B80: the doctor half of the tiny-window gate. Three `moss doctor` boots used to
 * run inside the same serial stage; alone they overlap with the other probes.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tiny-window-diagnostics',
  requires: ['build'],
  description:
    'doctor reports the tiny profile at 4096, the lean surface at 32k, neither above 64k',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tiny-window-diagnostics.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tiny-window-diagnostics] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
