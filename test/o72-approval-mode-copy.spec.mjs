#!/usr/bin/env node
/**
 * O72 (+O75): approval-mode copy and the non-interactive block.
 * Acceptance: docs/plan roadmap additions §14 / §17.
 *  - default resolves to full; --accept-edits resolves to acceptEdits (manual
 *    base, prompt) — safety is NOT loosened.
 *  - startup mode line exists for every mode and says how to change it.
 *  - --help documents accept-edits scope vs Claude Code (en + zh).
 *  - -p + --accept-edits blocks exec; the model-facing reason names the cause
 *    and never coaches the model to push the user to full mode.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { parseCliArgs } from '../dist/cli/args.js';
import { deriveEngineQuantas } from '../dist/cli/interaction-mode.js';
import {
  formatFullModeNotice,
  formatHeadlessBlockNotice,
  formatHeadlessBlockReason,
  formatInteractionModeNotice,
} from '../dist/cli/cli-locale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. resolution (was /tmp/o75.mjs): --accept-edits → acceptEdits; quantas unchanged.
{
  const parsed = parseCliArgs(['-p', 'hi', '--accept-edits'], {});
  assert.equal(parsed.interactionModeOverride, 'acceptEdits');
  const none = parseCliArgs(['-p', 'hi'], {});
  assert.equal(none.interactionModeOverride ?? null, null, 'no flag → config default (full)');
  assert.deepEqual(
    {
      s: deriveEngineQuantas('acceptEdits').safetyMode,
      a: deriveEngineQuantas('acceptEdits').approvalPolicy,
    },
    { s: 'workspace-write', a: 'prompt' },
    'accept-edits keeps the manual base (src/safety not loosened)'
  );
  assert.equal(deriveEngineQuantas('full').approvalPolicy, 'never');
}

// 2. startup line: every mode, both locales, says how to change it.
for (const mode of ['full', 'manual', 'acceptEdits', 'plan']) {
  assert.match(
    formatInteractionModeNotice(mode, 'C'),
    /^\[moss\] Interaction mode: .*\/mode to change/
  );
  assert.match(
    formatInteractionModeNotice(mode, 'zh_CN.UTF-8'),
    /^\[moss\] 交互模式：.*\/mode 可切换/
  );
}
assert.match(formatInteractionModeNotice('full', 'C'), /no approval prompts/);
assert.doesNotMatch(formatInteractionModeNotice('full', 'C'), /v0\.26/);
assert.match(formatInteractionModeNotice('acceptEdits', 'C'), /shell commands still ask/);
assert.match(formatFullModeNotice('C'), /edits files and runs commands without asking/);
assert.match(formatFullModeNotice('C'), /\/mode manual/);
assert.match(formatFullModeNotice('zh_CN'), /不逐条询问/);

// 3. user-facing block line names the flag and the way out.
assert.match(
  formatHeadlessBlockNotice('exec', 'acceptEdits', 'C'),
  /--accept-edits.*--full-access/
);
assert.match(formatHeadlessBlockNotice('exec', 'acceptEdits', 'zh_CN'), /--accept-edits/);

// 4. model-facing reason: cause yes, "switch to full" coaching no.
const FULL_COACHING = [
  /\/mode full/i,
  /--full-access/,
  /defaultMode\s*=\s*full/i,
  /switch (the mode )?to full/i,
  /切换到\s*full/,
  /完全执行/,
];
for (const mode of ['acceptEdits', 'manual']) {
  const reason = formatHeadlessBlockReason('exec', mode);
  for (const re of FULL_COACHING)
    assert.doesNotMatch(reason, re, `reason (${mode}) must not match ${re}`);
  assert.match(reason, /requires approval/);
  assert.match(reason, /Do not ask the user to change the approval mode/);
}
assert.match(formatHeadlessBlockReason('exec', 'acceptEdits'), /accept-edits/);

// 5. real hook, no TTY, accept-edits: exec blocked; edit allowed; reason clean.
{
  const tool = (name, sideEffectClass) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass, planMode: 'requires_user_confirmation' },
    execute: async () => 'ok',
  });
  const savedTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const hook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
        interactionMode: () => 'acceptEdits',
      }
    );
    const exec = await hook({
      tool: tool('exec', 'local_write'),
      input: { command: 'npm install surprise-package' },
      sessionKey: 'o72',
    });
    assert.equal(exec.approved, false, '-p + --accept-edits still blocks exec');
    for (const re of FULL_COACHING)
      assert.doesNotMatch(exec.reason, re, `hook reason must not match ${re}`);
    assert.ok(
      errs.some((l) => /Blocked: "exec".*--accept-edits/.test(l)),
      `stderr notice: ${errs.join('|')}`
    );
    const edit = await hook({
      tool: tool('edit_file', 'local_write'),
      input: { path: 'notes.txt', old_string: 'a', new_string: 'b' },
      sessionKey: 'o72',
    });
    assert.equal(edit.approved, true, 'accept-edits auto-approves workspace file edits');
  } finally {
    console.error = origErr;
    Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  }
}

// 6. help documents scope vs Claude Code, en + zh.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o72-help-'));
  const run = (lang) =>
    spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), '--help', '--all'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        MOSS_LANG: lang,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
  const en = run('en');
  assert.match(en.stdout, /--accept-edits: auto-approve file edits.*still ask.*Claude Code/);
  const zh = run('zh');
  assert.match(zh.stdout, /--accept-edits：自动通过本文件夹内的文件编辑.*Claude Code/);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('o72-approval-mode-copy: ok');
