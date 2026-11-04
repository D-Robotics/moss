/**
 * L1 verification-completion-gate probe (build dependency): the decision table
 * and the once-per-run bound are asserted deterministically.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'verification-gate',
  requires: ['build'],
  description: 'Verification completion gate decision table + once-per-run bound',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/verification-gate.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[verification-gate] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
