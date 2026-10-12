import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const mode of ['boot', 'chat']) {
  test(
    `TUI ${mode} storage failure is visible without unhandled rejection or PASS`,
    { timeout: 5000 },
    async () => {
      const tempParent = path.resolve(os.tmpdir());
      const root = await fs.mkdtemp(path.join(tempParent, 'moss-tui-refresh-error-'));
      assert.equal(path.dirname(path.resolve(root)), tempParent);
      assert.ok(path.basename(root).startsWith('moss-tui-refresh-error-'));
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL('./helpers/task-runtime-tui-error.mjs', import.meta.url)),
              root,
              mode,
            ],
            {
              env: {
                ...process.env,
                MOSS_CONFIG_DIR: path.join(root, 'config'),
                MOSS_NO_BUNDLED_DEFAULT: '1',
                MOSS_UI_LOCALE: 'en-US',
                LC_ALL: 'C',
                LANG: 'C',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            }
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
          });
          const timer = setTimeout(() => child.kill(), 4500);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
          });
        });
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.signal, null);
        assert.match(result.stdout, /"errorVisible":true,"ownerRetained":true/);
        assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|triggerUncaughtException/);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
}
