/**
 * Task-ledger deferral probe (backlog B05, task group): the six Task OS tools
 * are offered only when the run shows task intent, the workspace has a ledger,
 * or the host asked for task flow.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'task-ledger-reveal',
  requires: ['build'],
  description: 'Task OS tools are deferred until a run needs them',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-ledger-reveal.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[task-ledger-reveal] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
