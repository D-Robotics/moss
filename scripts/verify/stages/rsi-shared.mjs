import path from 'node:path';
import { runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'rsi-shared',
  requires: ['build'],
  description: 'signed shared instruction packages and scoped native adoption (offline)',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'examples/rsi-shared.mjs')],
      {
        cwd: context.root,
        env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
        timeoutMs: 60000,
      }
    );
    if (result.status !== 0 || result.timedOut)
      return {
        ok: false,
        detail: `shared registry probe exited ${result.status ?? result.signal}`,
      };
    const managed = await runProcess(
      process.execPath,
      [path.join(context.root, 'examples/rsi-managed.mjs')],
      {
        cwd: context.root,
        env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
        timeoutMs: 60000,
      }
    );
    return managed.status === 0 && !managed.timedOut
      ? { ok: true }
      : { ok: false, detail: `managed registry probe exited ${managed.status ?? managed.signal}` };
  },
};
