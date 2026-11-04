/**
 * Plan-mode end protocol probe (backlog B04): a plan turn that did tool work
 * must submit `exit_plan` (or ask a question) before it can end.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'plan-end',
  requires: ['build'],
  description: 'Plan mode requires a submitted plan (exit_plan) before the turn ends',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/plan-end.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[plan-end] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
