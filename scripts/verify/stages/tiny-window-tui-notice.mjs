/**
 * B80: the TUI half of the tiny-window gate. A real TUI under a PTY is the most
 * expensive probe in the gate; on its own it overlaps with everything else.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tiny-window-tui-notice',
  requires: ['build'],
  description: 'The TUI announces the tiny profile after its late context probe',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tiny-window-tui-notice.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 120_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tiny-window-tui-notice] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
