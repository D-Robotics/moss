/**
 * B80: the startup-notice half of the tiny-window gate, on its own so the verify
 * pool can overlap it with the doctor and TUI probes instead of paying one serial
 * 24s stage.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tiny-window-cli-boot',
  requires: ['build'],
  description: 'A tiny window announces the reduced profile at startup, wide windows stay quiet',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tiny-window-cli-boot.mjs')],
      { cwd: context.root, env: { ...process.env }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tiny-window-cli-boot] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
