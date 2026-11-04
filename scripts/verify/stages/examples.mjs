/**
 * Embedding examples: they are the living docs of the SDK contract and run
 * fully offline (scripted providers), so the fast gate can afford them.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

const EXAMPLES = [
  'examples/headless-run.mjs',
  'examples/repl-host.mjs',
  'examples/custom-tool-approval.mjs',
  'examples/skill-catalog.mjs',
];

export const stage = {
  name: 'examples',
  requires: ['build'],
  description: 'the four offline SDK embedding examples',
  async run(context) {
    for (const example of EXAMPLES) {
      const result = await runProcess(process.execPath, [path.join(context.root, example)], {
        cwd: context.root,
        env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
        timeoutMs: 2 * 60 * 1000,
      });
      if (result.timedOut) {
        return {
          ok: false,
          detail: `${example} timed out after ${formatDuration(result.durationMs)}`,
        };
      }
      if (result.status !== 0) {
        return { ok: false, detail: `${example} exited ${result.status ?? result.signal}` };
      }
      console.log(`[examples] ${example} ok in ${formatDuration(result.durationMs)}`);
    }
    return { ok: true };
  },
};
