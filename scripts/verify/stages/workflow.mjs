/**
 * D5 declarative orchestration probe (build dependency): plan validation,
 * dependency waves, failure isolation, resume, concurrency, CLI dry-run and one
 * real mock-mode step.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'workflow',
  requires: ['build'],
  description: 'Workflow plans: waves, blocked dependents, resume, real mock step',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/workflow.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[workflow] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
