/**
 * README parity stage (offline).
 *
 * The Chinese and English product pages must stay 1:1 (same sections, same
 * hero commands), every docs link must resolve, advertised tool counts must
 * match the build, and no internal ticket ids may leak into a public page.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'readme-parity',
  requires: ['build'],
  description: 'both READMEs stay 1:1, links resolve and advertised counts match the build',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/readme-parity.mjs')],
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
    console.log(`[readme-parity] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
