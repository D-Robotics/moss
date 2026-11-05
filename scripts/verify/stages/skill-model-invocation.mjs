/** Spec `disable-model-invocation`: user-only skills stay out of the model catalog. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-model-invocation',
  requires: ['build'],
  description:
    'A disable-model-invocation skill is user-invocable only: no catalog chars, refused by the skill tool, inlined by its slash command',
  async run(context) {
    const root = context.root;
    const probe = path.join(root, 'scripts/verify/skill-model-invocation.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: root,
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
