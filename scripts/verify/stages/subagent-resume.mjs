/**
 * Sub-agent resume probe (backlog B11): a finished sub-agent keeps its
 * conversation and `subagent_resume` replays it before the follow-up.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'subagent-resume',
  requires: ['build'],
  description: 'Finished sub-agents keep a resumable transcript',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/subagent-resume.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[subagent-resume] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
