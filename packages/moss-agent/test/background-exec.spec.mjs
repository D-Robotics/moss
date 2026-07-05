#!/usr/bin/env node
/**
 * background-exec — output capture + stop kill + safety gate.
 *
 * The subsystem previously had zero tests. These pin down:
 *  (1) full output capture for a fast-exiting process — 'exit' was used instead
 *      of 'close', so tail output could be lost when the process exited before
 *      the stdout pipe drained;
 *  (2) exec_stop kills a long-running process (SIGTERM → SIGKILL escalation);
 *  (3) exec_background blocks dangerous commands (isCommandDangerous gate).
 */
import assert from 'node:assert/strict';
import {
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
  setKillEscalationMsForTests,
} from '../dist/tools/background-exec.js';

const ctx = () => ({ abortSignal: new AbortController().signal });

async function waitForTerminalStatus(id, timeoutMs = 8000) {
  // Poll the snapshot — subscribing to lifecycle events races with fast-exiting
  // processes (the 'close' notification can fire before a post-execute
  // subscription is in place).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getBackgroundProcessSnapshot(id);
    if (snap && (snap.status === 'exited' || snap.status === 'killed' || snap.status === 'error')) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function extractBgId(out) {
  const m = out.match(/bg_\d+/);
  return m ? m[0] : null;
}

// ─── 1. full output captured for a fast-exiting process (exit vs close) ─────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: 'printf "line1\\nline2\\nline3\\n"', settle_ms: 0 },
    ctx(),
  );
  const id = extractBgId(out);
  assert.ok(id, `exec_background returned a bg id: ${out}`);
  const term = await waitForTerminalStatus(id);
  assert.ok(term, 'process reached a terminal status');
  const logs = await execLogsTool.execute({ id, tail: 100 }, ctx());
  assert.ok(/line1/.test(logs), 'line1 captured');
  assert.ok(/line2/.test(logs), 'line2 captured (tail not lost to the exit-before-drain race)');
  assert.ok(/line3/.test(logs), 'line3 captured');
}

// ─── 2. exec_stop kills a long-running process ─────────────────────────────
{
  setKillEscalationMsForTests(200); // speed up SIGTERM → SIGKILL
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: 'sleep 30', settle_ms: 0 },
    ctx(),
  );
  const id = extractBgId(out);
  assert.ok(id, 'long-running process started');
  const stopResult = await execStopTool.execute({ id }, ctx());
  assert.match(stopResult, /kill|stop|terminat/i, 'exec_stop reports termination');
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'long-running process reached terminal status after stop');
  // On POSIX, exec_stop sends SIGTERM→SIGKILL → status 'killed'. On Windows,
  // process termination semantics differ (no Unix signals) → status 'exited'.
  // Both mean the process was successfully terminated by exec_stop.
  assert.ok(
    term.status === 'killed' || term.status === 'exited',
    `process terminated by exec_stop (got status: ${term.status})`,
  );
}

// ─── 3. exec_background blocks dangerous commands ──────────────────────────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: 'rm -rf /', settle_ms: 0 },
    ctx(),
  );
  assert.match(out, /block/i, 'dangerous command is blocked by the safety gate');
}

console.log('  [PASS] background-exec: output capture, stop kill, safety gate');
