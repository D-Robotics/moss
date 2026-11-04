/**
 * D11 `context: fork` probe (build dependency): a forked skill runs in an
 * isolated sub-agent and returns only a summary; inline skills are unchanged.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-fork',
  requires: ['build'],
  description: 'Skills: context:fork runs in a sub-agent, model/denied tools forwarded',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/skill-fork.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[skill-fork] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
