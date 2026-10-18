/**
 * O152 r6 P2-W2 (QA r6): when the post-run protected-path check ITSELF throws,
 * exec and exec_background fail closed — a synthetic "(protected paths)"
 * change is reported, so the run ends exit 9 instead of '完成'.
 *
 * Fault injection: after the command has started, `fs.lstatSync` throws an
 * error whose `.code` getter also throws, so the error escapes the
 * per-path catch in the snapshot and reaches the catch branch under test.
 * Removing that catch-branch fail-closed (builtin.ts / background-exec.ts)
 * turns this spec red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execTool } from '../dist/tools/builtin.js';
import { execBackgroundTool } from '../dist/tools/background-exec.js';
import {
  backgroundProcesses,
  waitForBackgroundProcesses,
} from '../dist/core/tools/background-process-registry.js';
import { PROTECTED_PATHS_UNVERIFIED } from '../dist/safety/protected-path-snapshot.js';

const realLstat = fs.lstatSync;
let armed = false;
fs.lstatSync = function patched(p, ...rest) {
  if (armed) {
    const err = new Error('o152 injected post-run check fault');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('o152 injected fault (code getter)');
      },
    });
    throw err;
  }
  return realLstat.call(fs, p, ...rest);
};

let pass = 0;
const failures = [];
async function check(name, fn) {
  armed = false;
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}\n${err?.stack ?? err}`);
  } finally {
    armed = false;
  }
}

function makeWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-fault-'));
  fs.writeFileSync(path.join(ws, '.env'), 'A=1\n');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');
  return ws;
}

await check('exec: post-run check throws → synthetic change reported (fail-closed)', async () => {
  const ws = makeWs();
  const reported = [];
  const text = await execTool.execute(
    { command: `node -e "console.log('o152-armed')"` },
    {
      workspaceDir: ws,
      sessionKey: 'o152-fault-exec',
      reportProtectedPathChanges: (c) => reported.push(...c),
      // First streamed chunk = the command is running; arm for the after-check.
      onToolOutput: () => {
        armed = true;
      },
    }
  );
  armed = false;
  assert.ok(
    reported.some((c) => c.path === PROTECTED_PATHS_UNVERIFIED),
    `reported=${JSON.stringify(reported)} text=${String(text).slice(0, 400)}`
  );
  assert.match(String(text), /moss-o101-protected-path-modified|protected paths/i);
  fs.rmSync(ws, { recursive: true, force: true });
});

await check('exec_background: post-run check throws → proc.protectedPathChanges set', async () => {
  const ws = makeWs();
  const out = await execBackgroundTool.execute(
    { command: `node -e "setTimeout(()=>{},1500)"`, settle_ms: 0 },
    { workspaceDir: ws, sessionKey: 'o152-fault-bg' }
  );
  const id = String(out).match(/\bbg_\d+\b/)?.[0];
  assert.ok(id, `background id in: ${String(out).slice(0, 200)}`);
  armed = true;
  await waitForBackgroundProcesses([id], { mode: 'wait_all', timeoutMs: 20000 });
  armed = false;
  const proc = backgroundProcesses.get(id);
  assert.ok(proc, 'proc registered');
  assert.ok(
    (proc.protectedPathChanges ?? []).some((c) => c.path === PROTECTED_PATHS_UNVERIFIED),
    `protectedPathChanges=${JSON.stringify(proc.protectedPathChanges)}`
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

fs.lstatSync = realLstat;
console.log(`\n# o152-l3-check-fault: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
process.exit(0);
