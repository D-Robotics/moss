/**
 * MCP protocol probe (build dependency): tools/resources/prompts round-trip
 * against a local mock stdio server, through the real client and
 * `moss mcp test`. No network, no model call.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'mcp-protocol',
  requires: ['build'],
  description: 'MCP: resources/prompts round-trip and `moss mcp test` protocol surface',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/mcp-protocol.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[mcp-protocol] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
