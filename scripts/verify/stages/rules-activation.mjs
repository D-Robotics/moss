/**
 * Rule activation probe (backlog B06): description-only rules are requestable,
 * not always-on; globs and plain always rules keep their behavior.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'rules-activation',
  requires: ['build'],
  description: 'Instruction rules: always / globs / requestable-by-description',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/rules-activation.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[rules-activation] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
