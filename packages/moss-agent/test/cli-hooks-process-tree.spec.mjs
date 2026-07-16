import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';

if (process.platform !== 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hook-timeout-'));
  const pidFile = path.join(dir, 'child.pid');
  const hooks = createConfiguredHookCallbacks({
    SessionStart: [{
      command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
      timeoutMs: 1000,
    }],
  }, { workspaceDir: dir });

  await hooks.runSessionStart();
  assert.ok(fs.existsSync(pidFile), 'hook spawned the background child before timeout');
  const childPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  let childAlive = true;
  for (let attempt = 0; attempt < 250 && childAlive; attempt++) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      childAlive = false;
    }
  }
  assert.equal(childAlive, false, 'timed-out hook kills its background child process');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[PASS] CLI hook timeout kills process tree');
