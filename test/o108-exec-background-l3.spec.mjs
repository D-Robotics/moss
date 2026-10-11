#!/usr/bin/env node
/**
 * O108 — wire O101 layer-3 protected-path snapshot to exec_background
 * complete-exit (close/error), not merely when the tool returns a job id.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'dist/tools/background-exec.js'))) {
  console.error('# FAIL: dist missing — run npm run build first');
  process.exit(1);
}

const { execBackgroundTool, execLogsTool } = await import('../dist/tools/background-exec.js');
const { clearBackgroundRegistryForTests, getBackgroundProcessSnapshot } =
  await import('../dist/core/tools/background-process-registry.js');
const { formatOutcomeLine, resolveRunOutcome } = await import('../dist/cli/run-outcome.js');
const { createRunCompletionTracker, noteBackgroundProtectedPathMods, noteRunCompletionEvent } =
  await import('../dist/cli/run-completion.js');
const { PROTECTED_PATH_MOD_MARKER, formatProtectedPathModifiedNotice } =
  await import('../dist/safety/protected-path-snapshot.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o108-'));
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeHomeWs() {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ssh', 'authorized_keys'),
    'ssh-ed25519 AAAAplaceholder user\n'
  );
  fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=super-secret-value\n');
  return { home, ws };
}

function ctxFor(ws) {
  return { workspaceDir: ws, abortSignal: new AbortController().signal, sessionKey: 'o108' };
}

async function waitForTerminalStatus(id, timeoutMs = 8000) {
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
  const m = String(out).match(/bg_\d+/);
  return m ? m[0] : null;
}

const quote = (value) =>
  process.platform === 'win32'
    ? `"${String(value).replaceAll('"', '""')}"`
    : `'${String(value).replaceAll("'", "'\\''")}'`;

await check('A1: delayed ~/.ssh write via exec_background detected after exit', async () => {
  clearBackgroundRegistryForTests();
  const { home, ws } = makeHomeWs();
  const script = path.join(ws, 'delay-ssh.cjs');
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const home = process.env.HOME;',
      'setTimeout(() => {',
      '  fs.appendFileSync(path.join(home, ".ssh", "authorized_keys"), "O108-BYPASS\\n");',
      '  process.exit(0);',
      '}, 400);',
    ].join('\n')
  );
  const prevHome = process.env.HOME;
  const prevLocale = process.env.MOSS_LOCALE;
  process.env.HOME = home;
  process.env.MOSS_LOCALE = 'zh-CN';
  try {
    const out = await execBackgroundTool.execute(
      { command: `node ${quote(script)}`, settle_ms: 50 },
      ctxFor(ws)
    );
    const id = extractBgId(out);
    assert.ok(id, `expected bg id in: ${out}`);
    const term = await waitForTerminalStatus(id, 5000);
    assert.ok(term, 'background process should reach terminal status');
    assert.equal(term.status, 'exited');
    assert.ok(
      term.protectedPathChanges?.some(
        (c) => c.path.includes('.ssh') || c.path.includes('authorized_keys')
      ),
      `expected protectedPathChanges on snapshot, got ${JSON.stringify(term.protectedPathChanges)}`
    );
    const logs = await execLogsTool.execute({ id, tail: 200 }, ctxFor(ws));
    assert.match(logs, /已被修改/);
    assert.doesNotMatch(logs, /已拦截/);
    assert.ok(logs.includes(PROTECTED_PATH_MOD_MARKER));
    assert.ok(!logs.includes('O108-BYPASS'));
    assert.ok(!logs.includes('super-secret-value'));
  } finally {
    process.env.HOME = prevHome;
    if (prevLocale === undefined) delete process.env.MOSS_LOCALE;
    else process.env.MOSS_LOCALE = prevLocale;
  }
});

await check('A2: new .git/hooks via exec_background detected after exit', async () => {
  clearBackgroundRegistryForTests();
  const { home, ws } = makeHomeWs();
  const script = path.join(ws, 'add-hook.cjs');
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'setTimeout(() => {',
      '  fs.writeFileSync(path.join(process.cwd(), ".git", "hooks", "pre-commit"), "#!/bin/sh\\necho x\\n");',
      '  process.exit(0);',
      '}, 200);',
    ].join('\n')
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const out = await execBackgroundTool.execute(
      { command: `node ${quote(script)}`, settle_ms: 30 },
      ctxFor(ws)
    );
    const id = extractBgId(out);
    assert.ok(id);
    const term = await waitForTerminalStatus(id, 5000);
    assert.ok(term);
    assert.ok(
      term.protectedPathChanges?.some((c) => c.path.includes('hooks/pre-commit')),
      JSON.stringify(term.protectedPathChanges)
    );
  } finally {
    process.env.HOME = prevHome;
  }
});

await check('B1: benign echo background → 0 protectedPathChanges', async () => {
  clearBackgroundRegistryForTests();
  const { home, ws } = makeHomeWs();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cmd = process.platform === 'win32' ? 'echo hello-o108' : 'printf "hello-o108\\n"';
    const out = await execBackgroundTool.execute({ command: cmd, settle_ms: 200 }, ctxFor(ws));
    const id = extractBgId(out);
    assert.ok(id);
    const term = await waitForTerminalStatus(id, 5000);
    assert.ok(term);
    assert.equal(
      term.protectedPathChanges?.length ?? 0,
      0,
      `false positive: ${JSON.stringify(term.protectedPathChanges)}`
    );
    const logs = await execLogsTool.execute({ id, tail: 100 }, ctxFor(ws));
    assert.doesNotMatch(logs, /已被修改|Protected paths were modified/);
    assert.ok(!logs.includes(PROTECTED_PATH_MOD_MARKER));
  } finally {
    process.env.HOME = prevHome;
  }
});

await check('C1: bg L3 hit → resolveRunOutcome incomplete non-zero', async () => {
  clearBackgroundRegistryForTests();
  const { home, ws } = makeHomeWs();
  const script = path.join(ws, 'touch-env.cjs');
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      'fs.appendFileSync(".env", "LEAK=no\\n");',
      'process.exit(0);',
    ].join('\n')
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const out = await execBackgroundTool.execute(
      { command: `node ${quote(script)}`, settle_ms: 2000 },
      ctxFor(ws)
    );
    const id = extractBgId(out);
    assert.ok(id);
    const term = await waitForTerminalStatus(id, 5000);
    assert.ok(term);
    assert.ok(
      term.protectedPathChanges?.some((c) => c.path.includes('.env')),
      JSON.stringify(term.protectedPathChanges)
    );

    const tracker = createRunCompletionTracker();
    noteRunCompletionEvent(tracker, {
      type: 'tool_start',
      toolCallId: 'bg1',
      toolName: 'exec_background',
      input: { command: `node ${quote(script)}` },
    });
    noteRunCompletionEvent(tracker, {
      type: 'tool_end',
      toolCallId: 'bg1',
      toolName: 'exec_background',
      result: out,
      isError: false,
    });
    const outcome = resolveRunOutcome({
      tracker,
      finalText: 'All done, everything succeeded.',
      request: 'update env',
    });
    assert.equal(outcome.status, 'incomplete');
    assert.notEqual(outcome.exitCode, 0);
    const line = formatOutcomeLine(outcome, 'zh');
    assert.match(line, /未完成/);
    assert.match(line, /受保护路径|修改/);
    assert.doesNotMatch(line, /已拦截/);
    assert.ok(!line.includes('super-secret-value'));
    assert.ok(!line.includes('LEAK=no'));
  } finally {
    process.env.HOME = prevHome;
  }
});

await check('C2: notice uses 已被修改 not 已拦截', () => {
  const notice = formatProtectedPathModifiedNotice(
    [{ path: '~/.ssh/authorized_keys', kind: 'modified' }],
    true,
    'node delay-ssh.cjs'
  );
  assert.match(notice, /已被修改/);
  assert.doesNotMatch(notice, /已拦截/);
  assert.ok(notice.includes(PROTECTED_PATH_MOD_MARKER));
});

await check('D1: late-exit harvest from snapshot without marker in tool result', async () => {
  clearBackgroundRegistryForTests();
  const { home, ws } = makeHomeWs();
  const script = path.join(ws, 'late.cjs');
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'setTimeout(() => {',
      '  fs.appendFileSync(path.join(process.env.HOME, ".ssh", "authorized_keys"), "LATE\\n");',
      '  process.exit(0);',
      '}, 500);',
    ].join('\n')
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const out = await execBackgroundTool.execute(
      { command: `node ${quote(script)}`, settle_ms: 40 },
      ctxFor(ws)
    );
    assert.ok(
      !String(out).includes(PROTECTED_PATH_MOD_MARKER),
      `early return should lack marker: ${out}`
    );
    const id = extractBgId(out);
    assert.ok(id);
    const term = await waitForTerminalStatus(id, 5000);
    assert.ok(term?.protectedPathChanges?.length >= 1);

    const tracker = createRunCompletionTracker();
    noteRunCompletionEvent(tracker, {
      type: 'tool_start',
      toolCallId: 'late1',
      toolName: 'exec_background',
      input: { command: `node ${quote(script)}` },
    });
    noteRunCompletionEvent(tracker, {
      type: 'tool_end',
      toolCallId: 'late1',
      toolName: 'exec_background',
      result: out,
      isError: false,
    });
    assert.equal(tracker.protectedPathChanges?.length ?? 0, 0, 'pre-harvest must be empty');
    noteBackgroundProtectedPathMods(tracker);
    assert.ok(tracker.protectedPathChanges?.length >= 1, 'harvest must fold snapshot hits');

    // Revert-red proxy: clear registry so resolve harvest finds nothing → no L3 incomplete.
    const trackerNoHarvest = createRunCompletionTracker();
    noteRunCompletionEvent(trackerNoHarvest, {
      type: 'tool_start',
      toolCallId: 'late2',
      toolName: 'exec_background',
      input: { command: `node ${quote(script)}` },
    });
    noteRunCompletionEvent(trackerNoHarvest, {
      type: 'tool_end',
      toolCallId: 'late2',
      toolName: 'exec_background',
      result: out,
      isError: false,
    });
    clearBackgroundRegistryForTests();
    const without = resolveRunOutcome({
      tracker: trackerNoHarvest,
      finalText: 'All done, everything succeeded.',
      request: 'say hi',
    });
    assert.ok(
      without.status !== 'incomplete' ||
        !/protected|受保护/.test(without.reason + without.reasonZh),
      `without harvest must not L3-incomplete: ${JSON.stringify(without)}`
    );
  } finally {
    process.env.HOME = prevHome;
  }
});

console.log(`# tests done, failures=${failures}`);
if (failures > 0) process.exit(1);
console.log('# pass');
