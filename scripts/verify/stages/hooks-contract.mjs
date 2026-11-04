/**
 * D12 hook-contract probe: exit-code matrix, deny/ask precedence and
 * updatedInput semantics, asserted against dist/ (build dependency).
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'hooks-contract',
  requires: ['build'],
  description: 'PreToolUse hook contract (exit codes, precedence, updatedInput)',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/hooks-contract.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[hooks-contract] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
