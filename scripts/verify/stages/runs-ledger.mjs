/**
 * Unified run ledger stage (offline).
 *
 * Locks `.moss/runs/<runId>/run.json` (status vocabulary, defensive parsing,
 * pruning) and the `moss runs list|show|prune` read path.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'runs-ledger',
  requires: ['build'],
  description: 'one run ledger: task runs land in .moss/runs and moss runs reads them',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/runs-ledger.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
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
    console.log(`[runs-ledger] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
