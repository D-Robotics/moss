/**
 * MCP prompts as user-invocable slash commands (D4 parity slice): catalog,
 * expansion, `/mcp prompts`, `/mcp prompt ...`, and the requiresArgs split that
 * leaves bare `/mcp` to the host status panel. Requires build.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'mcp-prompt-slash',
  requires: ['build'],
  description: 'MCP prompts are listed and runnable from /mcp in both surfaces',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/mcp-prompt-slash.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[mcp-prompt-slash] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
