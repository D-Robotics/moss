/**
 * `moss artifacts` fold stage (offline, B131).
 *
 * `moss tasks` was a separate top-level verb one letter from `moss task`; it is
 * now `moss artifacts` (workspace command, no model config) with the old verb as
 * a working alias. Locks every kind, the alias equivalence, exit codes and help.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'task-artifacts',
  requires: ['build'],
  description:
    'moss artifacts: read-only closed-loop inspection without model config, old tasks alias',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/task-artifacts.mjs')],
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
    console.log(`[task-artifacts] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
