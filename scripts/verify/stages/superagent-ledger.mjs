/**
 * Super-agent tickets in the unified ledger (offline, B149/B150).
 *
 * Scripted worker + real Task Runtime gate: one completed and one blocked
 * ticket must each leave a kind=superagent record that `moss runs --kind
 * superagent` reads back.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'superagent-ledger',
  requires: ['build'],
  description: 'Super-agent tickets write kind=superagent run records (offline scripted worker)',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/superagent-ledger.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 180_000 }
    );
    if (result.timedOut) {
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    }
    if (result.status !== 0) {
      const lastLine = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}${lastLine ? `: ${lastLine}` : ''}`,
      };
    }
    console.log(`[superagent-ledger] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
