/**
 * `/todos` end-to-end: the model writes a todo_write checklist during a real
 * turn, the REPL keeps it live, and `/todos` renders it (Claude Code exposes the
 * task list the same way; Moss's TUI panel had no REPL counterpart).
 *
 * The probe drives a PTY REPL against a stub that answers with a todo_write tool
 * call, then types `/todos` and asserts the rendered rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

async function pythonWithPty() {
  if (process.platform === 'win32') return null;
  const probe = await captureProcess('python3', ['--version'], {});
  return probe.status === 0 ? 'python3' : null;
}

export const stage = {
  name: 'todos-view',
  requires: ['build'],
  description: 'REPL /todos renders the live todo_write checklist',
  async run(context) {
    const python = await pythonWithPty();
    if (!python) {
      console.log('[todos-view] skipping: python3/pty unavailable');
      return { ok: true };
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-todos-'));
    const started = Date.now();
    try {
      const result = await captureProcess(
        python,
        [
          path.join(context.root, 'scripts/verify/todos-view.py'),
          process.execPath,
          path.join(context.root, 'dist', 'cli.js'),
          tempRoot,
        ],
        { cwd: context.root, timeoutMs: 120_000 }
      );
      const duration = formatDuration(Date.now() - started);
      if (result.error) return { ok: false, detail: result.error.message };
      if (result.timedOut) return { ok: false, detail: 'the /todos probe timed out' };
      const payload = (() => {
        try {
          return JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '{}');
        } catch {
          return {};
        }
      })();
      if (payload.error) return { ok: false, detail: String(payload.error) };
      if (result.status !== 0) {
        const failed = Object.entries(payload.checks ?? {})
          .filter(([, ok]) => !ok)
          .map(([name]) => name);
        return {
          ok: false,
          detail:
            failed.length > 0 ? `/todos output missing: ${failed.join(', ')}` : 'probe failed',
        };
      }
      console.log(`[todos-view] checklist rendered in ${duration}`);
      return { ok: true };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
};
