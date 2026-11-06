/**
 * Spec-audit nudge precision stage (offline, B187): citation phrasing triggers,
 * plain doc mentions do not.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'spec-audit-nudge',
  requires: ['build'],
  description: 'spec-audit nudge fires on cited docs and stays quiet on plain mentions',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/spec-audit-nudge.mjs')],
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
    console.log(`[spec-audit-nudge] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
