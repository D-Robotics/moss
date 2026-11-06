/**
 * REPL guidance stage (offline, B156): catalog args, localized /help shortcuts,
 * the run-start stop hint and the mode-aware prompt wiring.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'repl-guidance',
  requires: ['build'],
  description: 'REPL /goal args, /help shortcuts and the pause/interrupt hint stay truthful',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/repl-guidance.mjs')],
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
    console.log(`[repl-guidance] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
