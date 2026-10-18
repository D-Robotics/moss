#!/usr/bin/env node
/**
 * O165: a hook that throws must block, visibly.
 *
 * - Any exception on a blocking-event path used to escape: PreToolUse and
 *   PermissionRequest bubbled up as tool/run errors, runStopHooks caught it
 *   and returned { blocked: false } — the exception silently approved the
 *   stop. All four gates (PreToolUse, UserPromptSubmit, PermissionRequest,
 *   Stop) now fail closed with a `[hooks] …` notice.
 * - A throwing Stop hook is a terminal veto: `fatal: true` — the REPL skips
 *   the forced continuation turn (no further model call) and the headless run
 *   ends Incomplete (exit 9).
 * - `-p` with a blocked UserPromptSubmit hook used to exit 8
 *   (TOOL_NOT_ALLOWED → TOOL_EXECUTION); it is INPUT_GUARDRAIL_DENIED →
 *   Incomplete (9) now, like every other 「被拦」 outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConfiguredHookCallbacks,
  runStopHooks,
  setLifecycleHookRunner,
} from '../dist/cli/hooks.js';
import { exitCodeForError, ExitCode } from '../dist/cli/exit-codes.js';
import { MossError, ErrorCode } from '../dist/errors.js';
import { createInputGuardrailDeniedError } from '../dist/core/agent/moss-agent-helpers.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o165-')));

async function quiet(fn) {
  const orig = process.stderr.write;
  const errs = [];
  process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
  try {
    return { value: await fn(), errs };
  } finally {
    process.stderr.write = orig;
  }
}

test.beforeEach(() => {
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
});

test.afterEach(() => {
  setLifecycleHookRunner(undefined);
});

// ── unit: the four gates fail closed on a throw ─────────────────────────────

/** A hook object whose `command` access throws — handling it must fail closed. */
function throwingHook() {
  return {
    get command() {
      throw new Error('boom-o165-matcher');
    },
  };
}

test('PreToolUse: a throw while handling the hook blocks the call', async () => {
  const cbs = createConfiguredHookCallbacks(
    { PreToolUse: [throwingHook()] },
    { workspaceDir: WORKSPACE }
  );
  const { value } = await quiet(() =>
    cbs.onBeforeToolExec({ tool: { name: 'exec' }, input: { command: 'true' } })
  );
  assert.equal(value.approved, false, JSON.stringify(value));
  assert.match(value.reason, /PreToolUse hook failed/i);
});

test('PermissionRequest: a throw while handling the hook denies', async () => {
  const cbs = createConfiguredHookCallbacks(
    { PermissionRequest: [throwingHook()] },
    { workspaceDir: WORKSPACE }
  );
  const { value } = await quiet(() =>
    cbs.runPermissionRequest({ toolName: 'exec', input: { command: 'true' } })
  );
  assert.equal(value.denied, true, JSON.stringify(value));
  assert.match(value.reason, /PermissionRequest hook failed/i);
});

test('Stop: a throwing lifecycle runner is a terminal veto (blocked + fatal)', async () => {
  setLifecycleHookRunner({
    runStop: async () => {
      throw new Error('boom-o165');
    },
  });
  const { value, errs } = await quiet(() =>
    runStopHooks({ sessionKey: 's', stopReason: 'end_turn' })
  );
  assert.equal(value.blocked, true, JSON.stringify(value));
  assert.equal(value.fatal, true, 'terminal: no continuation turn');
  assert.match(value.reason, /Stop hook threw.*boom-o165/);
  assert.match(errs.join(''), /Stop hook threw/);
});

test('Stop fatal copy in zh names the hook and the incomplete ending', async () => {
  installUiLanguage({ language: 'zh', source: 'flag', setting: 'auto' });
  setLifecycleHookRunner({
    runStop: async () => {
      throw new Error('boom-o165');
    },
  });
  const { value } = await quiet(() => runStopHooks({ sessionKey: 's' }));
  assert.match(value.reason ?? '', /停止前钩子执行抛出异常，已按拦截处理/);
  assert.match(value.reason ?? '', /不再调用模型/);
});

// ── unit: the exit code of a blocked prompt ────────────────────────────────

test('INPUT_GUARDRAIL_DENIED maps to Incomplete (9), not TOOL_EXECUTION (8)', () => {
  const err = createInputGuardrailDeniedError('s', 'r', 'hook says no');
  assert.ok(err instanceof MossError);
  assert.equal(err.code, ErrorCode.INPUT_GUARDRAIL_DENIED);
  assert.equal(exitCodeForError(err), ExitCode.INCOMPLETE);
  assert.equal(ExitCode.INCOMPLETE, 9);
});

// ── process: -p with a blocked UserPromptSubmit hook exits 9 ───────────────

const NOTES = 'original notes\n';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function cliPrompt(hookCommand, lang = 'en') {
  const r = await scenario({
    lang,
    hooks: { UserPromptSubmit: [{ command: hookCommand }] },
    steps: [
      {
        name: 'exec',
        args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
      },
    ],
    finalText: 'All done, everything is finished.',
    notesBody: NOTES,
  });
  return { ...r, unchanged: sha(r.notes) === sha(NOTES) };
}

test('-p: a blocked UserPromptSubmit hook → exit 9 (was 8), file unchanged, model never called', async () => {
  const r = await cliPrompt('node -e "process.exit(2)"');
  const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(-500)}`;
  assert.equal(r.code, 9, ctx);
  assert.equal(r.unchanged, true, 'the exec never ran; ' + ctx);
  assert.equal(r.toolResults.length, 0, 'no tool round-trip; the prompt was rejected');
  assert.match(r.last, /Blocked: .*UserPromptSubmit hook/, ctx);
});

test('-p zh: blocked UserPromptSubmit copy', async () => {
  const r = await cliPrompt('node -e "process.exit(2)"', 'zh');
  assert.equal(r.code, 9, `code=${r.code} last=${r.last}`);
  assert.match(r.last, /被拦/, r.last);
});

test('-p control: an allow UserPromptSubmit hook still runs (exit 0)', async () => {
  const r = await cliPrompt('node -e 0');
  assert.equal(r.code, 0, `code=${r.code} last=${r.last}\n${r.err.slice(-400)}`);
});
