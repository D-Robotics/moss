import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'edit-recovery',
  requires: ['build'],
  description: 'Failed editing recovers after a complete read without disabling loop protection',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/edit-recovery.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 30_000 }
    );
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
