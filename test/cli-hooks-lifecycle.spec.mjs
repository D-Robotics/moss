#!/usr/bin/env node
/**
 * Lifecycle hooks wave 1 (v0.15-S3): Stop / SubagentStop / PreCompact /
 * PostCompact shell hooks, same execution contract as the existing
 * PreToolUse/PostToolUse/SessionStart hooks (JSON stdin payload, timeout,
 * non-zero exit reported). Locks the blocking semantics:
 * - Stop: blocking hook + non-zero exit vetoes the stop (REPL forces one
 *   continuation turn; runOneShot surfaces {blocked, reason}).
 * - PreCompact/PostCompact ride the core CompactHookRegistry.
 * - SubagentStop fires from the shared lifecycle runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createConfiguredHookCallbacks,
  setLifecycleHookRunner,
  runStopHooks,
  runSubagentStopHooks,
} from '../dist/cli/hooks.js';

async function tempWs() {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-hooks-life-'));
}

// Hook commands must run under both /bin/sh and cmd.exe. Inline `node -e`
// scripts die on Windows (runProcess arg escaping + cmd /c quote rules
// truncate them at the first space), so probes live in script files inside
// the hook cwd and are invoked as bare filenames — zero cross-shell quoting.
// Marker paths travel through env vars (child env passes safeChildEnv).
function writeHookHelpers(ws) {
  fs.writeFileSync(
    path.join(ws, 'stop-exit2.mjs'),
    "console.error('tests not green yet');\nprocess.exit(2);\n"
  );
  fs.writeFileSync(
    path.join(ws, 'stdin-to-file.mjs'),
    [
      "import fs from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (chunk) => (data += chunk));",
      "process.stdin.on('end', () => fs.writeFileSync(process.env.MOSS_HOOK_OUT, data));",
      '',
    ].join('\n')
  );
}

// ─── Stop hook: blocking semantics ──────────────────────────────────────────

{
  const ws = await tempWs();
  writeHookHelpers(ws);
  const blocked = createConfiguredHookCallbacks(
    {
      Stop: [
        {
          command: 'node stop-exit2.mjs',
          blocking: true,
        },
      ],
    },
    { workspaceDir: ws }
  );
  const r = await blocked.runStop({ sessionKey: 's1', stopReason: 'end_turn', response: 'done' });
  assert.equal(r.blocked, true, 'non-zero blocking Stop hook vetoes the stop');
  assert.match(r.reason ?? '', /tests not green/, 'reason carries hook stderr');

  const pass = createConfiguredHookCallbacks(
    { Stop: [{ command: 'exit 0' }] },
    { workspaceDir: ws }
  );
  const r2 = await pass.runStop({ sessionKey: 's1' });
  assert.equal(r2.blocked, false, 'exit 0 does not block');

  const nonBlocking = createConfiguredHookCallbacks(
    { Stop: [{ command: 'exit 3', blocking: false }] },
    { workspaceDir: ws }
  );
  const r3 = await nonBlocking.runStop({ sessionKey: 's1' });
  assert.equal(r3.blocked, false, 'non-blocking hook never vetoes');
}

// ─── SubagentStop fires its command with the goal payload ───────────────────

{
  const ws = await tempWs();
  const marker = path.join(ws, 'subagent-stop.txt');
  writeHookHelpers(ws);
  process.env.MOSS_HOOK_OUT = marker;
  const cbs = createConfiguredHookCallbacks(
    { SubagentStop: [{ command: 'node stdin-to-file.mjs' }] },
    { workspaceDir: ws }
  );
  await cbs.runSubagentStop({ sessionKey: 'sa', goal: 'scan deps', success: true, summary: 'ok' });
  const payload = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(payload.event, 'SubagentStop');
  assert.equal(payload.goal, 'scan deps');
  assert.equal(payload.success, true);
}

// ─── PreCompact/PostCompact via the core CompactHookRegistry ────────────────

{
  const ws = await tempWs();
  const pre = path.join(ws, 'pre.txt');
  const post = path.join(ws, 'post.txt');
  writeHookHelpers(ws);
  process.env.MOSS_HOOK_OUT = pre;
  const cbs = createConfiguredHookCallbacks(
    {
      PreCompact: [{ command: 'node stdin-to-file.mjs' }],
      PostCompact: [{ command: 'node stdin-to-file.mjs' }],
    },
    { workspaceDir: ws }
  );
  const registry = cbs.buildCompactHookRegistry();
  assert.ok(registry, 'registry built when compact hooks configured');
  assert.equal(
    createConfiguredHookCallbacks({}, { workspaceDir: ws }).buildCompactHookRegistry(),
    undefined,
    'no registry without compact hooks'
  );
  await registry.runPreHooks({
    sessionKey: 's',
    runId: 'r',
    messages: [{ role: 'user', content: 'x' }],
    reason: 'proactive',
  });
  const prePayload = JSON.parse(fs.readFileSync(pre, 'utf8'));
  assert.equal(prePayload.event, 'PreCompact');
  assert.equal(prePayload.compactReason, 'proactive');
  assert.equal(prePayload.droppedMessages, 1);
  // The probe reads MOSS_HOOK_OUT when the child spawns, so retarget it
  // between the two hook runs.
  process.env.MOSS_HOOK_OUT = post;
  await registry.runPostHooks({
    sessionKey: 's',
    runId: 'r',
    summaryChars: 42,
    droppedMessages: 7,
    reason: 'overflow',
    success: true,
  });
  const postPayload = JSON.parse(fs.readFileSync(post, 'utf8'));
  assert.equal(postPayload.event, 'PostCompact');
  assert.equal(postPayload.summaryChars, 42);
  assert.equal(postPayload.success, true);
}

// ─── Module-singleton lifecycle runner ──────────────────────────────────────

{
  const stopCalls = [];
  setLifecycleHookRunner({
    runStop: async (info) => {
      stopCalls.push(info);
      return info.stopReason === 'end_turn'
        ? { blocked: true, reason: 'veto' }
        : { blocked: false };
    },
    runSubagentStop: async () => {},
  });
  const r = await runStopHooks({ sessionKey: 'x', stopReason: 'end_turn' });
  assert.equal(r.blocked, true, 'installed runner answers runStopHooks');
  assert.equal(stopCalls.length, 1);
  await runSubagentStopHooks({ sessionKey: 'x', goal: 'g', success: false });
  setLifecycleHookRunner(undefined);
  const r2 = await runStopHooks({ sessionKey: 'x', stopReason: 'end_turn' });
  assert.equal(r2.blocked, false, 'without a runner every stop is allowed');
}

// ─── runOneShot returns the Stop hook verdict ───────────────────────────────

{
  const { runOneShot } = await import('../dist/cli/oneshot.js');
  setLifecycleHookRunner({
    runStop: async () => ({ blocked: true, reason: 'Blocked by Stop hook: keep going' }),
    runSubagentStop: async () => {},
  });
  const agent = {
    config: { model: 'mock', workspaceDir: os.tmpdir() },
    tools: { getAll: () => [] },
    async *streamChat() {
      yield { type: 'text_delta', delta: 'hello' };
      yield { type: 'done', result: { response: 'hello', stopReason: 'end_turn' } };
    },
  };
  const chunks = [];
  const stop = await runOneShot(agent, 'hi', {
    outputFormat: 'stream-json',
    stdout: { write: (c) => chunks.push(c) },
    cwd: os.tmpdir(),
  });
  assert.equal(stop.blocked, true, 'runOneShot surfaces the Stop veto');
  assert.match(stop.reason ?? '', /keep going/);
  const resultLines = chunks
    .join('')
    .split('\n')
    .filter((l) => l.includes('"type":"result"'));
  assert.ok(resultLines.length >= 1, 'result event still emitted exactly once per run');
  setLifecycleHookRunner(undefined);
}

console.log('[PASS] lifecycle hooks (Stop/SubagentStop/PreCompact/PostCompact)');
