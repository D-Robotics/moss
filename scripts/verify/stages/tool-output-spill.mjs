/**
 * Tool-output spill probe (backlog B09): a truncated result from any tool keeps
 * a recovery file and the model is pointed at it; exec's own spill is not doubled.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tool-output-spill',
  requires: ['build'],
  description: 'Truncated tool results keep a recovery file the model can read',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tool-output-spill.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tool-output-spill] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
