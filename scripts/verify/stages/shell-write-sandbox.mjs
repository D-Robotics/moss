/**
 * Shell-write sandbox regression stage (offline, B91): realpath fallback for
 * symlinked roots (macOS `/tmp`) without weakening real escapes.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'shell-write-sandbox',
  requires: ['build'],
  description:
    'shell writes through symlinked roots (macOS /tmp) are allowed; real escapes still refused',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/shell-write-sandbox.mjs')],
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
    console.log(`[shell-write-sandbox] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
