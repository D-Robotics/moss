import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'task-observation',
  requires: ['build'],
  description: 'Generic readonly task waits avoid model polling and stop cleanly at their deadline',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-observation.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 30_000 }
    );
    if (result.timedOut || result.status !== 0)
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}\n${result.stdout}${result.stderr}`,
      };
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
