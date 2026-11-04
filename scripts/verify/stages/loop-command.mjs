/**
 * Closed-loop probe (build dependency): `moss loop --until` retry, exhaustion,
 * mandatory check command and exit codes are asserted deterministically with
 * the offline mock provider — no model call.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-command',
  requires: ['build'],
  description: 'Closed loop: retry on failed check, bounded attempts, check decides exit code',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/loop-command.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[review-pipeline] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
