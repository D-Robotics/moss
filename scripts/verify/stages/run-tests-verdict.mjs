/**
 * run_tests verdict probe: exit 0 is a pass even when the reporter is not one
 * of the parsed frameworks; red/timeout/spawn-failure stay failures; parsed
 * runner counts are unchanged. Requires build.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'run-tests-verdict',
  requires: ['build'],
  description: 'run_tests treats exit 0 as a pass and keeps failures/counts honest',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/run-tests-verdict.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[run-tests-verdict] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
