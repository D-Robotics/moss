/**
 * `moss run --resume` stage (offline, B139).
 *
 * Locks the argv shaping of the resume path, the empty-workspace usage error and
 * the documented help surface.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'run-resume',
  requires: ['build'],
  description: 'moss run --resume [<id>] shapes argv, errors clearly when nothing is resumable',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/run-resume.mjs')],
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
    console.log(`[run-resume] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
