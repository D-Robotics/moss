/**
 * Loop run-record stage (offline, B132).
 *
 * Locks the `moss loop` -> unified ledger mapping: passed/verify_failed,
 * incomplete for hung or silent signals, and round-trip through .moss/runs.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'loop-run-record',
  requires: ['build'],
  description: 'moss loop runs land in the unified ledger with the completion-gate vocabulary',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/loop-run-record.mjs')],
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
    console.log(`[loop-run-record] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
