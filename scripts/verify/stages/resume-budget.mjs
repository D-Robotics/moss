/**
 * Resume budget stage (B114).
 *
 * Locks that `moss task resume` carries its own repair/turn budget instead of
 * silently re-granting the run defaults, while keeping the defaults opt-in.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'resume-budget',
  requires: ['build'],
  description: 'task resume honours --max-repairs / --max-turns for that attempt',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/resume-budget.mjs')],
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
    console.log(`[resume-budget] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
