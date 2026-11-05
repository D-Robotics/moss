/**
 * Run-scoped question channel stage (B122).
 *
 * Locks the fix for the round-32 hang: an `ask_user_question` inside a task run
 * must resolve from stdin (or decline), never wait on the paused readline.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-question-ask',
  requires: ['build'],
  description: 'questions inside a task run resolve or decline instead of hanging',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-question-ask.mjs')],
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
    console.log(`[task-question-ask] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
