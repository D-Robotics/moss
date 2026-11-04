/**
 * H2 probe (build dependency): opt-in phased startup timing prints one line and
 * is off by default, with monotonic marks.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'startup-timing',
  requires: ['build'],
  description: 'Startup timing: MOSS_STARTUP_TIMING phased line, off by default',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/startup-timing.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[startup-timing] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
