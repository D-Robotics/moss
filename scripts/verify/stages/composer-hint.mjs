/**
 * Composer hint stage (offline, B191): the first hint follows the workspace, and a
 * checkout `.env` device host no longer leaks into unrelated folders.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'composer-hint',
  requires: ['build'],
  description: 'first-screen hint follows workspace kind; foreign .env device does not leak',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/composer-hint.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
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
    console.log(`[composer-hint] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
