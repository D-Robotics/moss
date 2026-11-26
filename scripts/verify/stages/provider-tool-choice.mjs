import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'provider-tool-choice',
  requires: ['build'],
  description:
    'A gateway that refuses `tool_choice: required` is retried once without it, and the decision stays enforced',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-intent-tool-choice-fallback.mjs')],
      {
        cwd: context.root,
        env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
        timeoutMs: 60_000,
      }
    );
    if (result.timedOut) return { ok: false, detail: 'tool-choice fallback probe timed out' };
    if (result.status !== 0)
      return { ok: false, detail: `${result.stdout}${result.stderr}`.trim() };
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
