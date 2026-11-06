/**
 * `moss runs export` stage (offline): single-run Markdown/JSON/--out and the
 * filtered combined report (split out of runs-ledger to keep the CI gate budget).
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'runs-export',
  requires: ['build'],
  description: 'runs export renders one run and filtered combined reports',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/runs-export.mjs')],
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
    console.log(`[runs-export] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
