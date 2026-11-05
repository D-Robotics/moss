/**
 * D3 tool-surface probe (build dependency): lean descriptions are short and
 * smaller on the wire; the MOSS_HIDE_TOOLS A/B switch hides exactly its names
 * and announces them in a real mock session.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tool-lean',
  requires: ['build'],
  description: 'Lean tool descriptions (<=120 chars) and the MOSS_HIDE_TOOLS experiment',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tool-lean.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[tool-lean] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
