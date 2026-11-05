/**
 * B66: a tiny context window gets a minimal tool surface and a window-sized
 * output/summary budget instead of failing the first request.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tiny-window-surface',
  requires: ['build'],
  description: 'Tiny context windows get a minimal tool surface and fit the window',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tiny-window-surface.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tiny-window-surface] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
