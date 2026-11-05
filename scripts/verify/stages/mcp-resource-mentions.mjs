/** D4: `@server:uri` prompt mentions attach MCP resources before the turn. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'mcp-resource-mentions',
  requires: ['build'],
  description:
    'User `@server:uri` mentions attach MCP resources (grammar, caps, live registry read)',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/mcp-resource-mentions.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 120_000,
    });
    if (result.timedOut || result.status !== 0) {
      return {
        ok: false,
        detail: `probe exited ${String(result.status ?? result.signal)}\n${result.stdout}${result.stderr}`,
      };
    }
    console.log(result.stdout.trim());
    return { ok: true };
  },
};
