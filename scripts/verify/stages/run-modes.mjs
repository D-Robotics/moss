/**
 * `moss goal` mode stage (offline, B140).
 *
 * One verb, three modifiers: --accept / --until / --workflow (+ --resume).
 * Locks classification, conflicts, help, and one real routing into the workflow
 * engine.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'run-modes',
  requires: ['build'],
  description: 'moss goal routes --accept / --until / --workflow / --resume as documented',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/run-modes.mjs')],
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
    console.log(`[run-modes] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
