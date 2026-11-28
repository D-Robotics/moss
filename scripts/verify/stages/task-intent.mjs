import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'task-intent',
  requires: ['build'],
  description:
    'User corrections update durable state and fence old plans without a second classifier',
  async run(context) {
    for (const script of [
      'task-intent-readonly-tools.mjs',
      'task-intent-decision-repair.mjs',
      'task-intent-revisions.mjs',
      'task-intent-store.mjs',
      'task-revision-probe.mjs',
    ]) {
      const result = await captureProcess(
        process.execPath,
        [path.join(context.root, 'scripts/verify', script)],
        {
          cwd: context.root,
          env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
          timeoutMs: 30_000,
        }
      );
      if (result.timedOut || result.status !== 0)
        return { ok: false, detail: `${script}: ${result.stdout}${result.stderr}` };
      console.log(result.stdout.trim());
    }
    return { ok: true };
  },
};
