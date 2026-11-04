/**
 * Sub-agent prompt contract probe (backlog B07): parent messages are not user
 * consent, and every shell call starts without a persisted working directory.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'subagent-prompt-contract',
  requires: ['build'],
  description: 'Sub-agent prompts state the authorization and absolute-path boundaries',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/subagent-prompt-contract.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[subagent-prompt-contract] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
