#!/usr/bin/env node
/**
 * batch-device — fleet_batch exec safety gate + shellEscape primitive.
 *
 * Pins down two security fixes:
 *  (1) `fleet_batch exec` now runs `isCommandDangerous` before fanning a
 *      command across the fleet (previously it skipped the check that
 *      `device_exec` has, so `fleet_batch exec "rm -rf /"` would run on every
 *      board with no gate).
 *  (2) `shellEscape` (used by `gatherFileFromDevice` after the fix) produces a
 *      single-quoted, injection-safe token — `cat "${filePath}"` previously
 *      allowed `$(...)` / backtick injection from the LLM-supplied path.
 */
import assert from 'node:assert/strict';
import { createBatchDeviceTool } from '../dist/tools/batch-device.js';
import { shellEscape } from '../dist/tools/ssh-utils.js';

const ctx = () => ({ abortSignal: new AbortController().signal });

// A disconnected device so exec proceeds past the "no devices" guard but does
// not attempt a real SSH connection (the safety check must fire before any
// device dispatch).
const tool = createBatchDeviceTool([
  { alias: 'd1', connected: false, config: { host: 'h', user: 'u', port: 22 } },
]);

// ─── 1. fleet_batch exec blocks dangerous commands before fleet dispatch ────
for (const cmd of ['rm -rf /', 'rm -rf -- /', 'rm -rf $HOME', 'mkfs /dev/sda', ':(){ :|:& };:']) {
  const out = await tool.execute({ action: 'exec', command: cmd }, ctx());
  assert.match(out, /Command blocked/i, `dangerous command blocked: ${cmd}`);
}

// ─── 2. a safe command is NOT blocked (reaches the device-dispatch path) ────
{
  const out = await tool.execute({ action: 'exec', command: 'ls -la' }, ctx());
  assert.doesNotMatch(out, /Command blocked/i, 'safe command is not blocked by the safety gate');
  // The disconnected device yields an "unreachable" status, proving the command
  // proceeded past the gate to device dispatch (rather than being blocked).
  assert.match(
    out,
    /unreachable|not connected/i,
    'safe command reached device dispatch (device unreachable)'
  );
}

// ─── 3. shellEscape produces single-quoted, injection-safe tokens ──────────
{
  assert.equal(shellEscape('foo'), "'foo'", 'plain arg is single-quoted');
  // An injection payload ends up literally inside single quotes, so `$(...)`
  // is not evaluated when the token is used as a shell argument.
  const payload = '$(rm -rf /)';
  const escaped = shellEscape(payload);
  assert.ok(escaped.startsWith("'") && escaped.endsWith("'"), 'escaped token is single-quoted');
  assert.ok(escaped.includes(payload), 'payload is literally inside the quotes (not evaluated)');
  // A single quote inside the arg is escaped POSIX-style ("'" -> '\'').
  assert.equal(shellEscape("a'b"), "'a'\\''b'", 'internal single quote is escaped');
}

console.log('  [PASS] batch-device: fleet exec safety gate + shellEscape injection safety');
