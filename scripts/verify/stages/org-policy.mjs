/** D9 organization policy file (`MOSS_POLICY_FILE`): loader + real rule engine. */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'org-policy',
  requires: ['build'],
  description: 'MOSS_POLICY_FILE rules load, fail closed, and win the decision',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/org-policy.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 180_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[org-policy] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
