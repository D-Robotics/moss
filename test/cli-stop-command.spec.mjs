#!/usr/bin/env node
/**
 * P1-3: /stop kills background processes. It does not abort the foreground run
 * (that is Esc). On main, /stop meant "interrupt the current reply".
 */
import assert from 'node:assert/strict';
import os from 'node:os';

import { findRegistryCommand } from '../dist/cli/commands/registry.js';
import { execBackgroundTool } from '../dist/tools/background-exec.js';
import {
  clearBackgroundRegistryForTests,
  listBackgroundProcessSnapshots,
  setKillEscalationMsForTests,
} from '../dist/core/tools/background-process-registry.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

setKillEscalationMsForTests(40);
try {
  const started = await execBackgroundTool.execute(
    { command: 'sleep 30', settle_ms: 80 },
    { workspaceDir: os.tmpdir(), sessionKey: 'stop-spec' }
  );
  assert.match(started, /Still running/, started);
  const running = listBackgroundProcessSnapshots().filter((proc) => proc.status === 'running');
  assert.equal(running.length, 1);
  const pid = running[0].pid;
  assert.equal(typeof pid, 'number');
  process.kill(pid, 0);

  const said = [];
  const match = findRegistryCommand('/stop');
  assert.ok(match);
  assert.equal(findRegistryCommand('/abort')?.spec, match.spec, '/abort is the same command');
  await match.spec.run(
    {
      agent: {},
      runtime: undefined,
      sessionKey: 'stop-spec',
      workspace: os.tmpdir(),
      surface: 'repl',
      say(_kind, text) {
        said.push(text);
      },
      prefillInput() {},
    },
    ''
  );
  assert.match(said.join('\n'), new RegExp(running[0].id));
  assert.match(said.join('\n'), /Esc/);

  let dead = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      dead = true;
      break;
    }
    await sleep(40);
  }
  assert.equal(dead, true, `background pid ${pid} is still alive after /stop`);
  const left = listBackgroundProcessSnapshots().filter((proc) => proc.status === 'running');
  assert.equal(left.length, 0);
} finally {
  clearBackgroundRegistryForTests();
}

console.log('[PASS] cli stop command');
