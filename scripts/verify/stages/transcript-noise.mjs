/**
 * Transcript-noise stage (offline, B172): device redirects never read as file
 * mutations, and the live wait line prints its bucket once.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'transcript-noise',
  requires: ['build'],
  description: 'no /dev/null mutation notice and no duplicated wait seconds in the transcript',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/transcript-noise.mjs')],
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
    console.log(`[transcript-noise] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
