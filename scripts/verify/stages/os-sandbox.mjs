/**
 * Opt-in OS sandbox probe (D14): opt-in resolution, refusal matrix, and — when
 * the host has sandbox-exec/bwrap — the real kernel-boundary acceptance.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'os-sandbox',
  requires: ['build'],
  description: 'Opt-in OS sandbox: refusals + real seatbelt/bwrap boundary',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/os-sandbox.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[os-sandbox] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
