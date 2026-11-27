import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'versioned-context',
  requires: ['build'],
  description:
    'Durable context corrections fence old checkpoints, actions and verdicts across restart',
  async run(context) {
    const probe = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/single-turn-recovery.mjs')],
      { cwd: context.root, timeoutMs: 20_000 }
    );
    if (probe.timedOut || probe.status !== 0)
      return { ok: false, detail: `${probe.stdout}${probe.stderr}` };
    console.log(probe.stdout.trim());
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/versioned-context.mjs')],
      {
        cwd: context.root,
        env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
        timeoutMs: 45_000,
      }
    );
    if (result.timedOut || result.status !== 0) {
      return { ok: false, detail: `${result.stdout}${result.stderr}` };
    }
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
