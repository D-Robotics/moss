/**
 * Explicit-memory probe (build dependency): `moss remember` previews without
 * writing, appends one fact to AGENTS.md, de-dupes, and bounds the fact size.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'remember',
  requires: ['build'],
  description: 'Explicit memory: /remember preview, append, de-dupe, size cap',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/remember.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[remember] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
