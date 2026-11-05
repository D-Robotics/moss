/**
 * `/todos` end-to-end: the model writes a todo_write checklist during a real
 * turn, the REPL keeps it live, and `/todos` renders it (Claude Code exposes the
 * task list the same way; Moss's TUI panel had no REPL counterpart).
 *
 * The probe drives a PTY REPL against a stub that answers with a todo_write tool
 * call, then types `/todos` and asserts the rendered rows.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDuration } from '../lib/proc.mjs';

export const stage = {
  name: 'todos-view',
  requires: ['build'],
  description: 'REPL /todos renders the live todo_write checklist',
  async run(context) {
    const python =
      process.platform === 'win32'
        ? null
        : spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0
          ? 'python3'
          : null;
    if (!python) {
      console.log('[todos-view] skipping: python3/pty unavailable');
      return { ok: true };
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-todos-'));
    const started = Date.now();
    try {
      const result = spawnSync(
        python,
        [
          path.join(context.root, 'scripts/verify/todos-view.py'),
          process.execPath,
          path.join(context.root, 'dist', 'cli.js'),
          tempRoot,
        ],
        { cwd: context.root, encoding: 'utf8', timeout: 120_000 }
      );
      const duration = formatDuration(Date.now() - started);
      if (result.error) return { ok: false, detail: result.error.message };
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
