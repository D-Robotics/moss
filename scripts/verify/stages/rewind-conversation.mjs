/** Claude parity: `/rewind` restores files AND drops the turn from LLM history. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'rewind-conversation',
  requires: ['build'],
  description: 'checkpoint message count + conversation truncation (offline scripted provider)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/rewind-conversation.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 120_000,
    });
    if (result.timedOut || result.status !== 0) {
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}\n${result.stdout}${result.stderr}`,
      };
    }
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
