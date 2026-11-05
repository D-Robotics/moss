/**
 * `moss capabilities` stage (offline, B133).
 *
 * Locks the one-screen capability panel: every registry (tools, skills,
 * commands, agents, hooks, MCP, devices) in one read-only view that needs no
 * model configuration, with JSON and human output and exit-2 argument checks.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'capabilities',
  requires: ['build'],
  description: 'moss capabilities: one screen for tools/skills/commands/agents/hooks/MCP/devices',
  async run(context) {
    const result = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/capabilities.mjs')],
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
    console.log(`[capabilities] ok in ${formatDuration(result.durationMs)}`);
    return { ok: true };
  },
};
