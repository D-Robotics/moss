/**
 * Help-surface contract: every dispatchable command is discoverable in
 * `moss --help --all` (en + zh) and the install/auth verbs execute.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'help-surface',
  requires: ['build'],
  description: 'Every CLI command appears in full help (en+zh); install/auth aliases run',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/help-surface.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[help-surface] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
