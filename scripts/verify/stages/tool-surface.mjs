/**
 * Tool-surface baseline and invariants (backlog B05 measurement slice).
 *
 * Every run pays for the declarations of every tool it offers, so the surface
 * is measured with the production filters instead of guessed: deferral really
 * hides the sub-agent group, plan mode really adds only `exit_plan`, a device
 * tool is never declared without a device (the defect this slice found and
 * fixed: `device_probe` leaked into device-less and plain-Q&A prompts), and
 * spawn scopes stay nested.
 */
import path from 'node:path';
import { formatDuration, runProcess } from '../lib/proc.mjs';

export const stage = {
  name: 'tool-surface',
  requires: ['build'],
  description: 'Tool declaration surface per run mode and per spawn scope',
  async run(context) {
    const result = await runProcess(
      process.execPath,
      [path.join(context.root, 'scripts/measure-tool-surface.mjs'), '--check'],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (result.timedOut)
      return { ok: false, detail: `timed out after ${formatDuration(result.durationMs)}` };
    if (result.status !== 0)
      return { ok: false, detail: `probe exited ${result.status ?? result.signal}` };
    console.log(`[tool-surface] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
