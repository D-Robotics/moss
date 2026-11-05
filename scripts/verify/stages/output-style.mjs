/** D15 output styles (`outputStyle` / `MOSS_OUTPUT_STYLE`): voice-only prompt layer. */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'output-style',
  requires: ['build'],
  description: 'outputStyle env/config precedence, prompt layer install/remove, config CLI',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/output-style.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 180_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    }
    console.log(`[output-style] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
