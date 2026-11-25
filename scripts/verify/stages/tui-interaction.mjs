/**
 * TUI interaction stage: the queue rows, transcript search, keymap and
 * `/copy` — pure projections first (node asserts), then the real wiring
 * (a PTY drives `dist/cli.js` against a local stub, stdlib python).
 *
 * The PTY half is skipped where python3/pty is missing, the same policy as
 * `slash-dispatch`; the projection half always runs.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

async function pythonWithPty() {
  if (process.platform === 'win32') return null;
  const probe = await captureProcess('python3', ['-c', 'import pty'], {});
  return probe.status === 0 ? 'python3' : null;
}

export const stage = {
  name: 'tui-interaction',
  requires: ['build'],
  description: 'TUI queue rows, transcript search, keymap and /copy behave as documented',
  async run(context) {
    const started = Date.now();
    const probe = await captureProcess(
      process.execPath,
      [path.join(context.root, 'scripts/verify/tui-interaction.mjs')],
      { cwd: context.root, env: { ...process.env, MOSS_NO_RDK_DOCS: '1' }, timeoutMs: 60_000 }
    );
    if (probe.timedOut) return { ok: false, detail: `projections timed out` };
    if (probe.status !== 0) {
      const lastLine = probe.stderr.trim().split('\n').slice(-1)[0] ?? '';
      return {
        ok: false,
        detail: `projections exited ${String(probe.status ?? probe.signal)}${lastLine ? `: ${lastLine}` : ''}`,
      };
    }
    const python = await pythonWithPty();
    if (!python) {
      console.log(
        `[tui-interaction] projections ok in ${formatDuration(Date.now() - started)}; PTY skipped`
      );
      return { ok: true };
    }
    const pty = await captureProcess(
      python,
      [
        path.join(context.root, 'scripts/verify/tui-interaction.py'),
        process.execPath,
        path.join(context.root, 'dist', 'cli.js'),
      ],
      { cwd: context.root, timeoutMs: 90_000 }
    );
    if (pty.timedOut) return { ok: false, detail: 'the PTY scenario timed out' };
    const payload = (() => {
      try {
        return JSON.parse((pty.stdout ?? '').trim().split('\n').pop() ?? '{}');
      } catch {
        return {};
      }
    })();
    if (pty.status !== 0 || payload.ok !== true) {
      return {
        ok: false,
        detail: `PTY scenario failed: ${String(payload.error ?? pty.status ?? pty.signal)}`,
      };
    }
    console.log(
      `[tui-interaction] projections + ${String(payload.checks)} PTY checks in ${formatDuration(Date.now() - started)}`
    );
    return { ok: true };
  },
};
