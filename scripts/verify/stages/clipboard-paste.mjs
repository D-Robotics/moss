/**
 * Ctrl+V attachment capture probe (backlog B01): clipboard image staging,
 * content-addressed mentions, size/magic guards. Real clipboard mutation is
 * opt-in via MOSS_VERIFY_CLIPBOARD=1.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'clipboard-paste',
  requires: ['build'],
  description: 'Ctrl+V stages a clipboard image as an @attachment',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/clipboard-paste.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[clipboard-paste] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
