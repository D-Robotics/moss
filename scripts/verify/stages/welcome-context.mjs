/**
 * Welcome context stage (offline, B136).
 *
 * The first REPL screen reads the unified run ledger + AGENTS.md: last run with
 * status/age/goal, and a next step that resumes a failed run instead of greeting
 * generically.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'welcome-context',
  requires: ['build'],
  description: 'first screen shows the last run and a resumable next step',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/welcome-context.mjs')],
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
    console.log(`[welcome-context] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
