/**
 * `moss init` onboarding stage (offline, B135).
 *
 * Locks detection (node/make/python/empty), the never-overwrite rule,
 * --dry-run, and the no-model-config requirement.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'init',
  requires: ['build'],
  description: 'moss init: detect entry points, write AGENTS.md once, print the next verified run',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/init.mjs')],
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
    console.log(`[init] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
