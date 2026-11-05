/**
 * Repair-budget honesty stage (B112).
 *
 * Locks that the engine's "repair budget exhausted" line reports the attempt
 * count the ledger shows (agent-initiated verification included), that
 * `--max-repairs 0` spends no repair turn, and that `moss task --help` derives
 * its defaults from the engine constants instead of a stale literal.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'repair-budget',
  requires: ['build'],
  description: 'repair budget failure line matches the ledger attempt count',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/repair-budget.mjs')],
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
    console.log(`[repair-budget] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
