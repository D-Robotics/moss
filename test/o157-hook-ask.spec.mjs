#!/usr/bin/env node
/**
 * O157 (P2): a PreToolUse hook that exits 0 with `ask` must make the user
 * confirm the call instead of letting it through.
 *
 * - Process level (real `dist/cli.js -p`, o121 harness, fake model server): the
 *   model runs an exec that overwrites notes.txt. `ask` (claude
 *   `hookSpecificOutput.permissionDecision`, moss `decision`) → exit 9,
 *   「被拦」/`Blocked by` last line, the -p copy, notes.txt hash unchanged.
 * - Interactive (in-process: MossAgent + the CLI policy hook in full mode,
 *   composed exactly as cli-main does, with a scripted y/a/n asker): the prompt
 *   names the hook and its reason; y and a write; n does not write, and the
 *   run outcome (the same resolveRunOutcome `moss -p` uses) is exit 9 被拦.
 *   Full mode auto-approves the tool without a hook (control case), so every
 *   prompt here comes from the hook.
 * - Merge order: deny + ask → blocked with no prompt; ask + allow → prompt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { composePreToolUseGate } from '../dist/cli/hook-ask.js';
import { createCliToolApprovalHook, setCliApprovalAsker } from '../dist/cli/approval.js';
import { createRunCompletionTracker, noteRunCompletionEvent } from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

/** `node -e` body in double quotes, single quotes inside: same on cmd.exe and sh. */
const nodeHook = (js) => `node -e "${js}"`;
const print = (obj) => nodeHook(`console.log(JSON.stringify(${obj}))`);

const HOOKS = {
  claudeAsk: {
    command: print(
      "{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'o157 needs a human'}}"
    ),
    format: 'claude',
  },
  mossAsk: { command: print("{decision:'ask',reason:'o157 moss wants a human'}") },
  claudeDeny: {
    command: print("{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'o157 deny'}}"),
    format: 'claude',
  },
  claudeAllow: {
    command: print("{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}"),
    format: 'claude',
  },
};

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

test.beforeEach(() => {
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
});

// ── Process level: real CLI -p ───────────────────────────────────────────────
const NOTES = 'original notes\n';
const WRITE_NOTES = {
  name: 'exec',
  args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
};

async function cli(hooks, lang = 'en') {
  const r = await scenario({
    lang,
    hooks: { PreToolUse: hooks },
    steps: [WRITE_NOTES],
    finalText: lang === 'zh' ? '全部完成，已经做好了。' : 'All done, everything is finished.',
    notesBody: NOTES,
  });
  return { ...r, unchanged: sha(r.notes) === sha(NOTES) };
}

function assertCliAskRefused(r, lang = 'en') {
  const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(-600)}`;
  assert.equal(r.code, 9, `exit 9; ${ctx}`);
  assert.equal(r.unchanged, true, `notes.txt hash must be unchanged; ${ctx}`);
  assert.match(r.last, lang === 'zh' ? /被拦：钩子拦下/ : /Blocked by: hook blocked/, ctx);
  const copy =
    lang === 'zh'
      ? /钩子要求人工确认，-p 模式下无法确认，已按拒绝处理/
      : /PreToolUse hook: it asked for confirmation, which -p mode cannot give; treated as deny/;
  assert.match(r.toolResults.join('\n'), copy, `tool result; ${ctx}`);
  assert.match(r.err.replace(/\s+/g, ' '), copy, `terminal; ${ctx}`);
}

test('-p claude permissionDecision:ask → exit 9 被拦, file unchanged, reason shown', async () => {
  const r = await cli([HOOKS.claudeAsk]);
  assertCliAskRefused(r);
  assert.match(r.toolResults.join('\n'), /reason: o157 needs a human/);
});

test('-p moss decision:ask → exit 9 被拦, file unchanged', async () => {
  assertCliAskRefused(await cli([HOOKS.mossAsk]));
});

test('-p zh copy: 钩子要求人工确认，-p 模式下无法确认，已按拒绝处理', async () => {
  assertCliAskRefused(await cli([HOOKS.claudeAsk], 'zh'), 'zh');
});

test('-p ask + allow (both orders) → still refused (ask beats allow)', async () => {
  assertCliAskRefused(await cli([HOOKS.claudeAsk, HOOKS.claudeAllow]));
  assertCliAskRefused(await cli([HOOKS.claudeAllow, HOOKS.claudeAsk]));
});

test('-p control: exit 0 + allow still writes (exit 0)', async () => {
  const r = await cli([HOOKS.claudeAllow]);
  assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
  assert.equal(r.unchanged, false, 'file written');
});

// ── Interactive: MossAgent + CLI policy hook (full mode) + scripted asker ───
async function quiet(fn) {
  const orig = process.stderr.write;
  const origErr = console.error;
  const errs = [];
  process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
  console.error = (...a) => errs.push(a.join(' '));
  try {
    return { value: await fn(), errs };
  } finally {
    process.stderr.write = orig;
    console.error = origErr;
  }
}

/**
 * One run: the model calls write_target `calls` times (each overwrites
 * out.txt), with `hooks` as PreToolUse and `answers` fed to the prompt.
 */
async function interactive(hooks, answers, { calls = 1, extraRules } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o157-'));
  const target = path.join(dir, 'out.txt');
  fs.writeFileSync(target, 'original\n');
  const before = sha(fs.readFileSync(target, 'utf8'));
  const cbs = createConfiguredHookCallbacks(
    { PreToolUse: hooks.map((h) => ({ ...h, source: '/o157/.moss/config.json' })) },
    { workspaceDir: dir }
  );
  const approvalHook = createCliToolApprovalHook('full-access', {}, {
    workspaceDir: dir,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
    ...(extraRules ? { permissionRules: () => ({ rules: extraRules, sources: {} }) } : {}),
  });
  const prompts = [];
  const queue = [...answers];
  const undo = approvalHook.setAsker(async (question) => {
    prompts.push(question);
    return queue.shift() ?? 'n';
  });
  const wasTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const transcript = [
    ...Array.from({ length: calls }, () => ({ toolCalls: [{ name: 'write_target', input: {} }] })),
    { text: 'All done, everything is finished.' },
  ];
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('o157', 'O157', transcript),
    sessionStore: new InMemorySessionStore(),
    model: 'o157',
    baseSystemPrompt: 'Write the file.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: calls + 3,
    hooks: { onBeforeToolExec: composePreToolUseGate(cbs.onBeforeToolExec, approvalHook) },
  });
  let executed = 0;
  agent.tools.register({
    name: 'write_target',
    description: 'Overwrite out.txt.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      executed += 1;
      fs.writeFileSync(target, `PWNED ${executed}\n`);
      return 'wrote out.txt';
    },
  });
  const tracker = createRunCompletionTracker();
  const results = [];
  let finalText = '';
  try {
    await quiet(async () => {
      for await (const ev of agent.streamChat(`o157-${Date.now()}-${Math.random()}`, 'go')) {
        noteRunCompletionEvent(tracker, ev);
        if (ev.type === 'tool_end' || ev.type === 'tool_result') results.push(ev);
        if (ev.type === 'text' && typeof ev.text === 'string') finalText += ev.text;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') finalText += ev.delta;
      }
    });
  } finally {
    undo();
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  }
  const outcome = resolveRunOutcome({
    tracker,
    finalText: finalText || 'All done, everything is finished.',
    request: 'go',
  });
  const after = sha(fs.readFileSync(target, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    executed,
    written: after !== before,
    prompts,
    resultText: JSON.stringify(results),
    exitCode: outcome.exitCode,
    last: formatOutcomeLine(outcome, 'en'),
  };
}

const assertNamesHook = (prompt, hook, reason) => {
  assert.ok(prompt.includes('PreToolUse hook asks for confirmation'), prompt);
  assert.ok(prompt.includes(hook.command), `prompt names the hook command:\n${prompt}`);
  if (reason) assert.ok(prompt.includes(`Reason: ${reason}`), `prompt shows the reason:\n${prompt}`);
};

test('interactive control: full mode, no hook ask → no prompt, file written', async () => {
  const r = await interactive([HOOKS.claudeAllow], []);
  assert.equal(r.prompts.length, 0, 'no prompt without a hook ask');
  assert.equal(r.written, true);
});

test('interactive ask × y → prompt names hook + reason, file written', async () => {
  const r = await interactive([HOOKS.claudeAsk], ['y']);
  assert.equal(r.prompts.length, 1, 'asked exactly once');
  assertNamesHook(r.prompts[0], HOOKS.claudeAsk, 'o157 needs a human');
  assert.equal(r.executed, 1);
  assert.equal(r.written, true, 'file written');
  assert.equal(r.exitCode, 0, r.last);
});

test('interactive ask × a → written; a approves only this call (asked again next call)', async () => {
  const r = await interactive([HOOKS.claudeAsk], ['a', 'a'], { calls: 2 });
  assert.equal(r.prompts.length, 2, 'the hook asks again on the second call');
  assertNamesHook(r.prompts[1], HOOKS.claudeAsk, 'o157 needs a human');
  assert.equal(r.executed, 2);
  assert.equal(r.written, true, 'file written');
});

test('interactive ask × n → file not written, run outcome exit 9 被拦', async () => {
  const r = await interactive([HOOKS.claudeAsk], ['n']);
  assert.equal(r.prompts.length, 1);
  assert.equal(r.executed, 0, 'tool must not run');
  assert.equal(r.written, false, 'file must be unchanged');
  assert.match(r.resultText, /Blocked by PreToolUse hook confirmation: user denied write_target/);
  assert.equal(r.exitCode, 9, r.last);
  assert.match(r.last, /Blocked by: hook blocked/, r.last);
});

test('interactive moss decision:ask × y / n behaves the same', async () => {
  const y = await interactive([HOOKS.mossAsk], ['y']);
  assert.equal(y.prompts.length, 1);
  assertNamesHook(y.prompts[0], HOOKS.mossAsk, 'o157 moss wants a human');
  assert.equal(y.written, true);
  const n = await interactive([HOOKS.mossAsk], ['n']);
  assert.equal(n.written, false);
  assert.equal(n.exitCode, 9, n.last);
});

test('merge: deny + ask (both orders) → blocked, no prompt', async () => {
  for (const hooks of [
    [HOOKS.claudeDeny, HOOKS.claudeAsk],
    [HOOKS.claudeAsk, HOOKS.claudeDeny],
  ]) {
    const r = await interactive(hooks, ['y']);
    assert.equal(r.prompts.length, 0, 'deny wins: nobody is asked');
    assert.equal(r.written, false, 'file must be unchanged');
    assert.match(r.resultText, /o157 deny/);
    assert.equal(r.exitCode, 9, r.last);
  }
});

test('merge: ask + allow (both orders) → confirmation prompt', async () => {
  for (const hooks of [
    [HOOKS.claudeAsk, HOOKS.claudeAllow],
    [HOOKS.claudeAllow, HOOKS.claudeAsk],
  ]) {
    const n = await interactive(hooks, ['n']);
    assert.equal(n.prompts.length, 1, 'ask beats allow: the user is asked');
    assert.equal(n.written, false);
    const y = await interactive(hooks, ['y']);
    assert.equal(y.prompts.length, 1);
    assert.equal(y.written, true);
  }
});

test('a permissions deny rule still wins over a hook ask (no prompt)', async () => {
  const r = await interactive([HOOKS.claudeAsk], ['y'], {
    extraRules: [{ level: 'deny', toolName: 'write_target', source: 'user' }],
  });
  assert.equal(r.prompts.length, 0);
  assert.equal(r.written, false);
});

test('no terminal and no asker: ask is refused with the no-terminal copy', async () => {
  const cbs = createConfiguredHookCallbacks({ PreToolUse: [HOOKS.claudeAsk] }, { workspaceDir: os.tmpdir() });
  const approvalHook = createCliToolApprovalHook('full-access', {}, { interactionMode: () => 'full' });
  const gate = composePreToolUseGate(cbs.onBeforeToolExec, approvalHook);
  const wasTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  setCliApprovalAsker(null);
  try {
    const { value: d } = await quiet(() =>
      gate({
        tool: { name: 'write_target', metadata: { sideEffectClass: 'local_write' } },
        input: {},
        toolCallId: 'o157-headless',
        sessionKey: 'o157',
        runId: 'o157',
        abortSignal: new AbortController().signal,
      })
    );
    assert.equal(d.approved, false);
    assert.match(d.reason, /asked for confirmation, but no interactive terminal is available; treated as deny/);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  }
});

test('a host that ignores hookAsks fails closed (configured hook alone refuses)', async () => {
  const cbs = createConfiguredHookCallbacks({ PreToolUse: [HOOKS.claudeAsk] }, { workspaceDir: os.tmpdir() });
  const d = await cbs.onBeforeToolExec({
    tool: { name: 'write_target' },
    input: {},
    toolCallId: 'o157-raw',
    sessionKey: 'o157',
    runId: 'o157',
    abortSignal: new AbortController().signal,
  });
  assert.equal(d.approved, false);
  assert.equal(d.hookAsks?.length, 1);
});

test('blocking:false hook: its ask is ignored like its deny (no prompt, written)', async () => {
  const r = await interactive([{ ...HOOKS.claudeAsk, blocking: false }], ['n']);
  assert.equal(r.prompts.length, 0);
  assert.equal(r.written, true);
});
