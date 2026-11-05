/**
 * D11 `background: true` probe: non-blocking skill starts, task completion,
 * empty-output failure, missing-runner error, background-over-fork, inline
 * control. Requires build.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-background',
  requires: ['build'],
  description: 'Skill background:true starts a non-blocking sub-agent task',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/skill-background.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[skill-background] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
