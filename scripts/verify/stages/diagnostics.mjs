/**
 * D8 diagnostics probe: the aggregated tsc/eslint tool normalizes findings,
 * caps them, filters by path, and reports clean/missing-toolchain states.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'diagnostics',
  requires: ['build'],
  description: 'diagnostics tool: tsc/eslint findings normalized, capped, filtered',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/diagnostics.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 180_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[diagnostics] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
