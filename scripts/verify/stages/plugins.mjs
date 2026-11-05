/**
 * D1 capability-pack probe (build dependency): validate / install / list /
 * remove a local pack and confirm the real loaders see its assets.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'plugins',
  requires: ['build'],
  description: 'Capability packs: validate, install, drift, remove, trust refusal',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/plugins.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[plugins] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
