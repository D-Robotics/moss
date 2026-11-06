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
    // On a heavily loaded machine the stub turn can miss the PTY timing and the
    // checklist never renders; retry once with a fresh root before calling it a
    // regression (a genuine /todos break fails both attempts).
    const attempts = 2;
    let lastDetail = 'the /todos probe failed';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `moss-todos-${String(attempt)}-`));
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
        if (result.error) {
          lastDetail = result.error.message;
          continue;
        }
        if (result.timedOut) {
          lastDetail = 'the /todos probe timed out';
          continue;
        }
        const payload = (() => {
          try {
            return JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '{}');
          } catch {
            return {};
          }
        })();
        if (payload.error) {
          lastDetail = String(payload.error);
          continue;
        }
        if (result.status !== 0) {
          const failed = Object.entries(payload.checks ?? {})
            .filter(([, ok]) => !ok)
            .map(([name]) => name);
          const tail = String(payload.output ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(-320);
          lastDetail =
            (failed.length > 0 ? `/todos output missing: ${failed.join(', ')}` : 'probe failed') +
            (tail ? ` — saw: ${tail}` : '');
          continue;
        }
        console.log(
          `[todos-view] checklist rendered in ${duration}${attempt > 1 ? ' (retry after load)' : ''}`
        );
        return { ok: true };
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
    return { ok: false, detail: `${lastDetail} (after ${String(attempts)} attempts)` };
  },
};
