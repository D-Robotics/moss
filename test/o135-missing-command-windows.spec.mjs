#!/usr/bin/env node
/**
 * O135 (P1 safety): on Windows a missing command must be a start failure,
 * never an ordinary non-zero exit that fail-opens the hook gate or reports
 * exec success.
 * - exec (pwsh): `The term 'x' is not recognized …` (CommandNotFoundException, exit 1)
 * - exec/hook (cmd.exe): `'x' is not recognized as an internal or external command`
 *   (cmd /c normalizes ERRORLEVEL 9009 to exit 1 — see specs/O135.md)
 * Wording per PM/UX 2026-10-12: blocked spawn_failed names the command and says
 * treated as deny (zh 「未能启动，已按拒绝处理」, en "failed to start; treated as deny").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyShellToolFailure,
  parseMissingCommandName,
} from '../dist/core/tools/tool-loop-guard.js';
import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { execTool } from '../dist/tools/builtin.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const IS_WIN = process.platform === 'win32';
const MISSING = 'moss-o135-missing-cmd';

// ---- exec: real spawn through the host shell (pwsh on win32, sh elsewhere) ----
// O135 root cause: pwsh/cmd report a missing command as exit 1 (not 9009/127).
// The exec tool must still surface it as a start failure that names the command.
test('exec: real missing command → start_failure and the command is named', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135-exec-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const text = await execTool.execute({ command: MISSING }, { workspaceDir, sessionKey: 'o135' });
  assert.equal(classifyShellToolFailure(text), 'start_failure', text.slice(0, 300));
  assert.equal(parseMissingCommandName(text), MISSING, text.slice(0, 300));
  assert.doesNotMatch(text, /^exit_code:\s*0\b/);
});

test(
  'exec win32: real `cmd /c <missing>` (exit 1) → start_failure, named',
  { skip: !IS_WIN && 'platform mismatch (not win32)' },
  async (t) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135-exec-'));
    t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
    const text = await execTool.execute(
      { command: `cmd /d /c ${MISSING}` },
      { workspaceDir, sessionKey: 'o135' }
    );
    assert.equal(classifyShellToolFailure(text), 'start_failure', text.slice(0, 300));
    assert.equal(parseMissingCommandName(text), MISSING, text.slice(0, 300));
  }
);

test('counterexample: started command that printed "not recognized" stays normal_nonzero', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135-exec-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const forged = Buffer.from(
    `'${MISSING}' is not recognized as an internal or external command,`
  ).toString('base64');
  const text = await execTool.execute(
    {
      command: `node -e "process.stdout.write(Buffer.from('${forged}','base64').toString());process.exit(1)"`,
    },
    { workspaceDir, sessionKey: 'o135' }
  );
  assert.equal(classifyShellToolFailure(text), 'normal_nonzero', text.slice(0, 300));
});

// ---- hooks ----
function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}

async function runWrite(hooksConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135-'));
  const target = path.join(dir, 'out.txt');
  const cbs = createConfiguredHookCallbacks(hooksConfig, { workspaceDir: dir });
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('o135', 'O135', [
      { toolCalls: [{ name: 'write_target', input: {} }] },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'o135',
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
  const events = [];
  const orig = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (c) => ((stderr += String(c)), true);
  try {
    for await (const ev of agent.streamChat(`o135-${Date.now()}`, 'write it')) {
      if (ev.type === 'tool_result' || ev.type === 'tool_end') events.push(ev);
    }
  } finally {
    process.stderr.write = orig;
  }
  return { written: fs.existsSync(target), resultText: JSON.stringify(events), stderr };
}

const NODE_EXIT = (code) => `node -e "process.exit(${code})"`;

for (const lang of ['en', 'zh']) {
  const denied =
    lang === 'zh'
      ? new RegExp(`已拦截：工具使用前钩子 \`${MISSING}\` 未能启动，已按拒绝处理`)
      : new RegExp(`Blocked: PreToolUse hook \`${MISSING}\` failed to start; treated as deny`);

  for (const format of [undefined, 'claude']) {
    test(`[${lang}] ${format ?? 'moss'} hook, missing command → denied + UX wording`, async () => {
      useLang(lang);
      const r = await runWrite({
        PreToolUse: [{ command: MISSING, ...(format ? { format } : {}) }],
      });
      assert.equal(r.written, false, 'fail-closed: write must not land');
      assert.match(r.resultText, denied);
      assert.doesNotMatch(r.resultText, /完成：|Completed:/);
    });
  }

  test(
    `[${lang}] win32: hook via pwsh -Command <missing> → denied (CommandNotFound)`,
    { skip: !IS_WIN && 'platform mismatch (not win32)' },
    async () => {
      useLang(lang);
      const r = await runWrite({
        PreToolUse: [{ command: `pwsh -NoProfile -Command ${MISSING}`, format: 'claude' }],
      });
      assert.equal(r.written, false, 'fail-closed: write must not land');
      assert.match(
        r.resultText,
        lang === 'zh'
          ? /工具使用前钩子 `pwsh [^`]+` 未能启动，已按拒绝处理/
          : /PreToolUse hook `pwsh [^`]+` failed to start; treated as deny/,
        'pwsh exit 1 + CommandNotFound counts as failed to start'
      );
    }
  );

  test(
    `[${lang}] win32: claude Stop hook via pwsh -Command <missing> → blocked as failed to start`,
    { skip: !IS_WIN && 'platform mismatch (not win32)' },
    async () => {
      useLang(lang);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135-'));
      const command = `pwsh -NoProfile -NonInteractive -Command ${MISSING}`;
      const cbs = createConfiguredHookCallbacks(
        { Stop: [{ command, format: 'claude' }] },
        { workspaceDir: dir }
      );
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      let value;
      try {
        value = await cbs.runStop({ stopReason: 'end_turn' });
      } finally {
        process.stderr.write = orig;
      }
      assert.equal(value.blocked, true, 'claude exit 1 would allow; missing command must block');
      assert.match(
        value.reason,
        lang === 'zh' ? /未能启动，已按拒绝处理/ : /failed to start; treated as deny/
      );
    }
  );

  // Control: hook exists and starts, exits non-zero — NOT a start failure.
  // O135: PreToolUse fails closed on any non-zero without an allow decision.
  test(`[${lang}] hook exists, exits 1: both formats block; neither says "could not start"`, async () => {
    useLang(lang);
    const moss = await runWrite({ PreToolUse: [{ command: NODE_EXIT(1) }] });
    assert.equal(moss.written, false);
    const claude = await runWrite({ PreToolUse: [{ command: NODE_EXIT(1), format: 'claude' }] });
    assert.equal(claude.written, false);
    for (const r of [moss, claude]) {
      assert.doesNotMatch(
        r.resultText + r.stderr,
        /could not start|failed to start|未能启动|无法启动/
      );
    }
  });
  test(`[${lang}] hook exists, exits 2 (claude) → blocked`, async () => {
    useLang(lang);
    const r = await runWrite({ PreToolUse: [{ command: NODE_EXIT(2), format: 'claude' }] });
    assert.equal(r.written, false);
  });
}
