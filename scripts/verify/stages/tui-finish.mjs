/**
 * TUI finish polish stage (offline, B168): outcome-line suppression, collapsed
 * todo checklist after a run, and de-duplicated failed-exec output.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'tui-finish',
  requires: ['build'],
  description:
    'TUI run-end transcript stays quiet: no redundant outcome, todo, or error duplicates',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tui-finish.mjs')],
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
    console.log(`[tui-finish] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
