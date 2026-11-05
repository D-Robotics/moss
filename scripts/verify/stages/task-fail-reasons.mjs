/**
 * `moss task list` failure-reason projection (B113).
 *
 * A fail/blocked row says the run failed; this stage proves it also says why —
 * the symptom the agent recorded in `.moss/task-failures.jsonl` is projected
 * onto the row (table and `--json`) instead of being invisible.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-fail-reasons',
  requires: ['build'],
  description: 'task list fail/blocked rows show the recorded failure symptom',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-fail-reasons.mjs')],
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
    console.log(`[task-fail-reasons] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
