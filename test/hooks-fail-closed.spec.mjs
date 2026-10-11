#!/usr/bin/env node
/**
 * O88: a blocking hook that never gives a verdict (could not start / timed
 * out) must fail closed, with a reason the model and the user both see.
 *
 * End-to-end through MossAgent: a scripted model calls `write_target`, whose
 * execute() really writes a file. Blocked cases assert the file is absent and
 * the tool result is an error; allowed cases assert the file exists and the
 * terminal (stderr) names the hook and the reason (QA Q1/Q2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { resolveProjectCapabilities } from '../dist/cli/workspace-trust.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const IS_WIN = process.platform === 'win32';
const MISSING = 'moss-o88-definitely-missing-cmd';
const SLEEP_5S = IS_WIN ? 'ping -n 6 127.0.0.1 >NUL' : 'sleep 5';
const CONFIG = '/tmp/o88/.moss/config.json';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o88-'));
}

function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}

/** Capture process.stderr while fn runs. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

/** Run one scripted turn: the model calls write_target once. */
async function runWrite(hooksConfig, { dir = tmp(), callbacks } = {}) {
  const target = path.join(dir, 'out.txt');
  const cbs = callbacks ?? createConfiguredHookCallbacks(hooksConfig, { workspaceDir: dir });
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('o88', 'O88', [
      { toolCalls: [{ name: 'write_target', input: {} }] },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'o88',
    baseSystemPrompt: 'Write the file.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
    hooks: { onBeforeToolExec: cbs.onBeforeToolExec },
  });
  agent.tools.register({
    name: 'write_target',
    description: 'Write out.txt.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      fs.writeFileSync(target, 'written\n');
      return 'wrote out.txt';
    },
  });
  const toolResults = [];
  const started = Date.now();
  const { stderr } = await captureStderr(async () => {
    for await (const ev of agent.streamChat(`o88-${Date.now()}`, 'write it')) {
      if (ev.type === 'tool_result' || ev.type === 'tool_end') toolResults.push(ev);
    }
  });
  const elapsedMs = Date.now() - started;
  const resultText = JSON.stringify(toolResults);
  return { written: fs.existsSync(target), stderr, resultText, toolResults, elapsedMs, dir };
}

/** O88 failure reason: next steps are only "fix the command" or `blocking: false`. */
function assertFailureReason(r) {
  assert.match(r.resultText, /blocking: false/, 'reason offers blocking: false as next step');
  assert.doesNotMatch(
    r.resultText,
    /full mode|--trust-workspace|trust/i,
    'never suggests trust/full'
  );
}

function assertBlocked(r, reasonRe) {
  assert.equal(r.written, false, 'blocked: target file must NOT exist');
  assert.match(
    r.resultText,
    /"is_?[eE]rror":true|"isError":true|"error"/,
    'tool result is an error'
  );
  assert.match(r.resultText, reasonRe, 'tool result carries the reason');
}

for (const lang of ['en', 'zh']) {
  const notStarted = lang === 'zh' ? /未能启动/ : /could not start/;
  const timedOut = lang === 'zh' ? /超时/ : /timed out/;

  test(`[${lang}] moss format + missing command blocks the write`, async () => {
    useLang(lang);
    const r = await runWrite({ PreToolUse: [{ command: MISSING, source: CONFIG }] });
    assertBlocked(r, notStarted);
    assertFailureReason(r);
    assert.match(r.resultText, new RegExp(MISSING), 'reason names the hook command');
    assert.match(r.resultText, /\/tmp\/o88\/\.moss\/config\.json/, 'reason names the config file');
    assert.match(r.stderr, notStarted, 'terminal shows the same reason');
  });

  test(`[${lang}] claude format + missing command blocks the write`, async () => {
    useLang(lang);
    const r = await runWrite({ PreToolUse: [{ command: MISSING, format: 'claude' }] });
    assertBlocked(r, notStarted);
  });

  for (const format of [undefined, 'claude']) {
    test(`[${lang}] ${format ?? 'moss'} format + timeout blocks, fast, child killed`, async () => {
      useLang(lang);
      const dir = tmp();
      const pidFile = path.join(dir, 'hook.pid');
      const command = IS_WIN ? SLEEP_5S : `echo $$ > ${JSON.stringify(pidFile)}; ${SLEEP_5S}`;
      const r = await runWrite(
        { PreToolUse: [{ command, timeoutMs: 300, ...(format ? { format } : {}) }] },
        { dir }
      );
      assertBlocked(r, timedOut);
      assertFailureReason(r);
      assert.ok(r.elapsedMs < 3000, `blocked within 3s (took ${r.elapsedMs}ms)`);
      if (!IS_WIN && fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try {
            process.kill(pid, 0);
            await new Promise((res) => setTimeout(res, 10));
          } catch {
            alive = false;
          }
        }
        assert.equal(alive, false, 'timed-out hook process is gone');
      }
    });
  }
}

test('claude format + exit 1 allows the write but surfaces hook and exit code', async () => {
  useLang('en');
  const r = await runWrite({
    PreToolUse: [{ command: 'echo oops >&2; exit 1', format: 'claude', source: CONFIG }],
  });
  assert.equal(r.written, true, 'allowed: file must exist');
  assert.match(r.stderr, /PreToolUse hook exited with code 1/);
  assert.match(r.stderr, /echo oops/, 'terminal names the hook command');
  assert.match(r.stderr, /oops/, 'stderr summary shown');
});

test('claude format + exit 2 still blocks (regression)', async () => {
  useLang('en');
  const r = await runWrite({
    PreToolUse: [{ command: 'echo nope >&2; exit 2', format: 'claude' }],
  });
  assertBlocked(r, /nope/);
});

test('blocking:false + missing command allows the write and shows the reason', async () => {
  useLang('en');
  const r = await runWrite({ PreToolUse: [{ command: MISSING, blocking: false, source: CONFIG }] });
  assert.equal(r.written, true, 'allowed: file must exist');
  assert.match(r.stderr, /PreToolUse hook could not start; not blocking/);
  assert.match(r.stderr, new RegExp(MISSING));
});

test('repeated failures in one turn print one terminal notice', async () => {
  useLang('en');
  const dir = tmp();
  const cbs = createConfiguredHookCallbacks(
    { PreToolUse: [{ command: MISSING, blocking: false }] },
    { workspaceDir: dir }
  );
  const req = { tool: { name: 'write_target' }, input: {}, sessionKey: 's', runId: 'r' };
  const { stderr } = await captureStderr(async () => {
    await cbs.onBeforeToolExec(req);
    await cbs.onBeforeToolExec(req);
    await cbs.onBeforeToolExec(req);
  });
  assert.equal(stderr.match(/could not start/g)?.length, 1);
});

// Q4: every blocking event fails closed when its hook cannot start.
test('UserPromptSubmit / Stop / PermissionRequest fail closed on a missing command', async () => {
  useLang('en');
  const dir = tmp();
  const cbs = createConfiguredHookCallbacks(
    {
      UserPromptSubmit: [{ command: MISSING, format: 'claude' }],
      Stop: [{ command: MISSING, format: 'claude' }],
      PermissionRequest: [{ command: MISSING, format: 'claude' }],
    },
    { workspaceDir: dir }
  );
  await captureStderr(async () => {
    const ups = await cbs.runUserPromptSubmit('hi');
    assert.equal(ups.blocked, true);
    assert.match(ups.reason, /could not start/);
    const stop = await cbs.runStop({ stopReason: 'end_turn' });
    assert.equal(stop.blocked, true);
    assert.match(stop.reason, /could not start/);
    const perm = await cbs.runPermissionRequest({ toolName: 'write_file', input: {} });
    assert.equal(perm.denied, true);
    assert.match(perm.reason, /could not start/);
  });
});

// Q5: untrusted project hooks never run, so they cannot "fail to start".
test('untrusted dir: project hook does not run; user hook still applies', async () => {
  useLang('en');
  const root = tmp();
  const ws = path.join(root, 'ws');
  const configDir = path.join(root, 'cfg');
  const projectConfigPath = path.join(ws, '.moss', 'config.json');
  const marker = path.join(root, 'user-hook-ran');
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify({ hooks: { PreToolUse: [{ command: MISSING }] } })
  );
  const userCmd = IS_WIN ? `type nul > "${marker}"` : `touch ${JSON.stringify(marker)}`;
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ command: userCmd }] } })
  );
  const caps = await resolveProjectCapabilities({
    interactive: false,
    headlessUntrusted: true,
    trustFlag: false,
    env: {},
    zh: false,
    workspaceDir: ws,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    projectConfigPath,
  });
  const callbacks = createConfiguredHookCallbacks(caps.hooks, { workspaceDir: ws });
  const r = await runWrite(undefined, { dir: ws, callbacks });
  assert.equal(r.written, true, 'write succeeds');
  assert.doesNotMatch(r.stderr + r.resultText, /could not start|未能启动/);
  assert.equal(fs.existsSync(marker), true, 'user-level hook still ran');
});

// Windows: cmd.exe reports an unknown command as exit 9009.
test(
  'win32: missing command via cmd.exe blocks (claude format)',
  { skip: !IS_WIN && 'platform mismatch (not win32)' },
  async () => {
    useLang('en');
    const r = await runWrite({ PreToolUse: [{ command: MISSING, format: 'claude' }] });
    assertBlocked(r, /could not start/);
  }
);
