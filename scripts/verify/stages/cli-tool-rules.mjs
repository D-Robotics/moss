/** Claude parity: `--allowed-tools` / `--disallowed-tools` become session rules. */
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'cli-tool-rules',
  requires: ['build'],
  description: 'CLI --allowed-tools/--disallowed-tools parse and resolve as session rules',
  async run(context) {
    const probe = path.join(context.root, 'scripts/verify/cli-tool-rules.mjs');
    const result = await captureProcess(process.execPath, [probe], {
      cwd: context.root,
      timeoutMs: 60_000,
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
