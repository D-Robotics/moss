/**
 * Resume verify-first stage (B116).
 *
 * Locks that a resume checks the workspace before buying an agent turn, while
 * fresh runs keep the execution-first ordering.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'resume-verify-first',
  requires: ['build'],
  description: 'task resume verifies before spending an execution turn',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/resume-verify-first.mjs')],
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
    console.log(`[resume-verify-first] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
