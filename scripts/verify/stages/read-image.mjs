/**
 * Image-link probe (backlog B01 first slice): read_image exists, guards what it
 * attaches, and a tool-result image survives session→provider conversion.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'read-image',
  requires: ['build'],
  description: 'read_image attaches images and tool-result images reach the provider request',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/read-image.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[read-image] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
