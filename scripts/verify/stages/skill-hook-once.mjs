/** D11: `once: true` retires a skill-declared hook after its first success. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-hook-once',
  requires: ['build'],
  description: 'Skill hooks honour `once: true` (claim, retire on success, re-arm on failure)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/skill-hook-once.mjs');
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
