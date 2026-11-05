/**
 * Headless chat run-record stage (offline, B134).
 *
 * Locks `moss -p` -> unified ledger: gate status, reason, next step, session
 * artifact, and the `moss runs --status` read path.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'chat-run-record',
  requires: ['build'],
  description: 'headless moss -p runs land in the unified ledger with gate status and next step',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/chat-run-record.mjs')],
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
    console.log(`[chat-run-record] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
