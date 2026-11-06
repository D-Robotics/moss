/**
 * Shell approval stage (offline, B175): read-only chains skip the manual-mode
 * prompt while writes/substitutions keep asking; multiline subjects stay whole.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'shell-approval',
  requires: ['build'],
  description: 'read-only shell chains run without a prompt; writes still confirm',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/shell-approval.mjs')],
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
    console.log(`[shell-approval] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
