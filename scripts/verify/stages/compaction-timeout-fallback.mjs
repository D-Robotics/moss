/**
 * B13 (build dependency): a slow summarizer must fall back to the deterministic
 * summary instead of silently skipping compaction.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'compaction-timeout-fallback',
  requires: ['build'],
  description: 'Compaction prepare timeout falls back to a deterministic summary',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/compaction-timeout-fallback.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[compaction-timeout-fallback] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
