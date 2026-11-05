/**
 * `moss task list` review verdict projection (B108).
 *
 * A goal run's outcome says pass/fail; this stage proves the row also says
 * *why* — the `review_changes` verdict that decided it is projected from
 * `.moss/review.jsonl` and rendered in the table and `--json`.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-review',
  requires: ['build'],
  description: 'task list projects the review verdict that decided each goal run',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-review.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.timedOut) {
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    }
    if (result.status !== 0) {
      const lastLine = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}${lastLine ? `: ${lastLine}` : ''}`,
      };
    }
    console.log(`[task-review] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
