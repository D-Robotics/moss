/**
 * D11 skill-declared hooks probe: frontmatter `hooks` path, activation on skill
 * load, real PreToolUse/PostToolUse execution, dropped lifecycle events, fail
 * closed on a broken/missing/escaping hooks file. Requires build.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'skill-hooks',
  requires: ['build'],
  description: 'Skill-declared hooks activate and run through the real hook pipeline',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/skill-hooks.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 120_000 }
    );
    if (result.status !== 0) {
      return { ok: false, detail: `probe exited ${String(result.status ?? result.signal)}` };
    }
    console.log(`[skill-hooks] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
