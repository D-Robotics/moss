/**
 * Hook contract probe (D12): the exit-code matrix, decision precedence and
 * updatedInput semantics are product behavior, not implementation detail. The
 * repo has no spec suite, so this runs as a verify stage against dist/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hooks-contract-'));
const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const hooksModule = await import(pathToFileURL(path.join('dist', 'cli', 'hooks.js')).href);

// One probe script per behavior; argv selects the exit code and JSON body.
const probe = path.join(root, 'probe.mjs');
fs.writeFileSync(
  probe,
  `let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const mode = process.argv[2] ?? '';
  // JSON bodies travel base64-encoded: shell quoting would strip their quotes.
  const body = mode.startsWith('b64:') ? Buffer.from(mode.slice(4), 'base64').toString('utf8') : '';
  if (body) process.stdout.write(body);
  if (mode === 'has-response') {
    // Stop payload probe: the recipe depends on payload.response being delivered.
    let parsed = {};
    try {
      parsed = JSON.parse(raw === '' ? '{}' : raw);
    } catch {}
    process.exit(typeof parsed.response === 'string' && parsed.response.length > 0 ? 0 : 2);
  }
  const code = mode.startsWith('exit:') ? Number(mode.slice(5)) : 0;
  process.exit(code);
});
`
);
const cmd = (mode) => `"${process.execPath}" "${probe}" ${mode}`;
const jsonCmd = (value) =>
  cmd(`b64:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`);
const tool = { name: 'write_file', metadata: { sideEffectClass: 'mutating' } };
const req = (input = { path: 'a.txt', content: 'x' }) => ({
  tool,
  input,
  sessionKey: 'probe',
  runId: 'probe',
  toolCallId: 'probe',
  abortSignal: new AbortController().signal,
});
const make = (pre) =>
  hooksModule.createConfiguredHookCallbacks({ PreToolUse: pre }, { workspaceDir: ws });
const decide = async (callbacks) => callbacks.onBeforeToolExec?.(req());

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

await check('native exit 0 allows', async () => {
  const d = await decide(make([{ command: cmd('exit:0') }]));
  assert.equal(d.approved, true);
});
await check('native exit 1 blocks (moss is stricter than claude)', async () => {
  const d = await decide(make([{ command: cmd('exit:1') }]));
  assert.equal(d.approved, false);
});
await check('native exit 2 blocks', async () => {
  const d = await decide(make([{ command: cmd('exit:2') }]));
  assert.equal(d.approved, false);
});
// PreToolUse is a safety gate: it blocks on any non-zero exit in BOTH formats
// (deliberately stricter than Claude Code, which only blocks on exit 2).
await check('claude format exit 1 still blocks PreToolUse', async () => {
  const d = await decide(make([{ command: cmd('exit:1'), format: 'claude' }]));
  assert.equal(d.approved, false);
});
await check('claude format exit 2 blocks', async () => {
  const d = await decide(make([{ command: cmd('exit:2'), format: 'claude' }]));
  assert.equal(d.approved, false);
});
await check('blocking:false cannot block', async () => {
  const d = await decide(make([{ command: cmd('exit:1'), blocking: false }]));
  assert.equal(d.approved, true);
});
await check('explicit deny decision blocks even on exit 0', async () => {
  const d = await decide(make([{ command: jsonCmd({ decision: 'deny', reason: 'nope' }) }]));
  assert.equal(d.approved, false);
  assert.match(d.reason, /nope/);
});
await check('ask decision is surfaced, not silently allowed', async () => {
  const d = await decide(make([{ command: jsonCmd({ decision: 'ask' }) }]));
  assert.equal(d.approved, false);
  assert.ok(Array.isArray(d.hookAsks) && d.hookAsks.length === 1);
});
await check('deny wins over ask across hooks', async () => {
  const d = await decide(
    make([
      { command: jsonCmd({ decision: 'ask' }) },
      { command: jsonCmd({ decision: 'deny', reason: 'hard no' }) },
    ])
  );
  assert.equal(d.approved, false);
  assert.match(d.reason, /hard no/);
  assert.equal(d.hookAsks, undefined);
});
await check('updatedInput replaces the whole input', async () => {
  const d = await decide(
    make([
      {
        command: jsonCmd({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { path: 'b.txt', content: 'rewritten' },
          },
        }),
      },
    ])
  );
  assert.equal(d.approved, true);
  assert.deepEqual(d.updatedInput, { path: 'b.txt', content: 'rewritten' });
});
await check('blocking:false cannot rewrite input', async () => {
  const d = await decide(
    make([
      {
        command: jsonCmd({ updatedInput: { path: 'b.txt', content: 'rewritten' } }),
        blocking: false,
      },
    ])
  );
  assert.equal(d.approved, true);
  assert.equal(d.updatedInput, undefined);
});

// ── Stop: the user-pluggable completion gate ────────────────────────────────
const stopCallbacks = (hooks) =>
  hooksModule.createConfiguredHookCallbacks({ Stop: hooks }, { workspaceDir: ws });
const runStop = (hooks) =>
  stopCallbacks(hooks).runStop({ sessionKey: 'probe', response: 'the change is done' });

await check('Stop exit 0 allows the run to end', async () => {
  const r = await runStop([{ command: cmd('exit:0') }]);
  assert.equal(r.blocked, false);
});
await check('Stop non-zero exit vetoes the ending', async () => {
  const r = await runStop([{ command: cmd('exit:2') }]);
  assert.equal(r.blocked, true);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});
await check('Stop blocking:false is advisory only', async () => {
  const r = await runStop([{ command: cmd('exit:2'), blocking: false }]);
  assert.equal(r.blocked, false);
});
await check('Stop receives the final response', async () => {
  const r = await runStop([{ command: cmd('has-response') }]);
  assert.equal(r.blocked, false, 'hook must see payload.response');
});
await check('a Stop hook that cannot start fails closed', async () => {
  const r = await runStop([{ command: 'moss-hook-that-does-not-exist-xyz' }]);
  assert.equal(r.blocked, true);
});

for (const line of checks) console.log(`[hooks-contract] ${line}`);
fs.rmSync(root, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[hooks-contract] ${failed.length}/${checks.length} contract checks failed`);
  process.exit(1);
}
console.log(`[hooks-contract] ${checks.length} contract checks passed`);
