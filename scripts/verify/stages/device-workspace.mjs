/**
 * Device workspace stage (offline): persistent-shell wire protocol, the
 * workspace→device sync planner, and the device tool surface contract.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'device-workspace',
  requires: ['build'],
  description:
    'device persistent shell framing, ROS auto-source, workspace sync planner, device_sync tool',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/device-workspace.mjs')],
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
    console.log(`[device-workspace] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
