#!/usr/bin/env node
/**
 * O106 — on Windows, cmd.exe "command not found" (exit 9009) must classify as
 * a launch/start failure exactly like 127: counted in loop-guard byToolFailure,
 * same user-facing hint structure (zh + en), missing command name reusing the
 * O96 safe-charset (≤64) logic and omitted when unparseable (never "unknown").
 * On non-win32, 9009 stays a normal non-zero exit (O96 semantics unchanged).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createToolLoopGuardState,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  formatToolLoopGuardMessage,
  classifyShellToolFailure,
  parseMissingCommandName,
} from '../dist/core/tools/tool-loop-guard.js';

// cmd.exe shapes: `exit_code: N` header form and `Command failed (exit N)`
// first-line form. Classification must key off the exit code only, never off
// stdout text like "is not recognized ..." (O97 lesson).
const CMD_NOT_RECOGNIZED =
  "'foo' is not recognized as an internal or external command,\noperable program or batch file.\n";
const WIN_HEADER = `exit_code: 9009\n${CMD_NOT_RECOGNIZED}`;
const WIN_FIRSTLINE = `Command failed (exit 9009):\n${CMD_NOT_RECOGNIZED}`;

test('classify: win32 + 9009 → start_failure (header and first-line forms)', () => {
  assert.equal(classifyShellToolFailure(WIN_HEADER, 'win32'), 'start_failure');
  assert.equal(classifyShellToolFailure(WIN_FIRSTLINE, 'win32'), 'start_failure');
});

test('classify: non-win32 + 9009 → normal_nonzero', () => {
  assert.equal(classifyShellToolFailure(WIN_HEADER, 'linux'), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(WIN_FIRSTLINE, 'linux'), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(WIN_HEADER, 'darwin'), 'normal_nonzero');
  assert.equal(classifyShellToolFailure(WIN_FIRSTLINE, 'darwin'), 'normal_nonzero');
});

test('classify: platform defaults to process.platform when omitted', () => {
  const expected = process.platform === 'win32' ? 'start_failure' : 'normal_nonzero';
  assert.equal(classifyShellToolFailure(WIN_HEADER), expected);
  assert.equal(classifyShellToolFailure(WIN_FIRSTLINE), expected);
});

test('classify: exit-code structure only — stdout text never drives 9009/start_failure', () => {
  // exit_code: 1 whose stdout merely looks like cmd "not recognized" text.
  assert.equal(
    classifyShellToolFailure(`exit_code: 1\n${CMD_NOT_RECOGNIZED}`, 'win32'),
    'normal_nonzero'
  );
  // "Command failed (exit 9009)" buried below the first line is stdout, not a header.
  assert.equal(
    classifyShellToolFailure(`exit_code: 1\nCommand failed (exit 9009): x\n`, 'win32'),
    'normal_nonzero'
  );
});

test('classify: O96 126/127 and ordinary non-zero semantics unchanged on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(
      classifyShellToolFailure('exit_code: 127\nsh: foo: not found\n', platform),
      'start_failure'
    );
    assert.equal(
      classifyShellToolFailure('exit_code: 126\nbash: foo: Permission denied\n', platform),
      'start_failure'
    );
    assert.equal(
      classifyShellToolFailure('Command failed (exit 127):\nfoo: not found\n', platform),
      'start_failure'
    );
    // Ordinary lint/test non-zero must NOT count as tool failure (O96).
    assert.equal(
      classifyShellToolFailure('Command failed (exit 1):\neslint: 3 errors\n', platform),
      'normal_nonzero'
    );
    assert.equal(
      classifyShellToolFailure('exit_code: 1\nnpm run check failed\n', platform),
      'normal_nonzero'
    );
  }
});

test('A: win32 + 9009 x3 → byToolFailure 3; hint identical in structure to 127 (zh + en)', () => {
  const runGuard = (output, platform) => {
    const state = createToolLoopGuardState();
    for (let i = 0; i < 3; i++) {
      recordToolLoopOutcome(state, 'exec', true, output, { command: `foo ${i}` }, platform);
    }
    assert.equal(state.byToolFailure.get('exec'), 3);
    const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'foo 9' });
    assert.ok(blocked, 'must short-circuit after 3 start failures');
    assert.match(blocked, /failed to start 3 time/i);
    const msg = formatToolLoopGuardMessage(blocked, 'exec');
    assert.match(msg, /未能启动/, 'zh copy');
    assert.match(msg, /failed to start/i, 'en copy');
    assert.doesNotMatch(msg, /STOP calling|工具不可用|is not returning usable results/);
    return { blocked, msg };
  };
  // 9009 on win32 vs the O96 127 baseline: same generic copy (no parseable name).
  const win9009 = runGuard('exit_code: 9009\n', 'win32');
  const win9009FirstLine = runGuard('Command failed (exit 9009):\n', 'win32');
  const base127 = runGuard('exit_code: 127\n', 'win32');
  assert.equal(win9009.msg, base127.msg, 'hint structure must equal the 127 case');
  assert.equal(win9009FirstLine.msg, base127.msg);
  // Unparseable name → omitted entirely; never "unknown"/「未知」, no bare exit code only.
  assert.doesNotMatch(win9009.msg, /unknown|未知/i);
  assert.doesNotMatch(win9009.blocked, /missing command/);
  assert.doesNotMatch(win9009.msg, /装依赖或改命令|install the dependency/);
});

test('A2: win32 + 9009 with an O96-parseable name → same name copy as 127 (safe charset ≤64)', () => {
  const runGuard = (output) => {
    const state = createToolLoopGuardState();
    for (let i = 0; i < 3; i++) {
      recordToolLoopOutcome(state, 'exec', true, output, { command: 'x' }, 'win32');
    }
    assert.equal(state.byToolFailure.get('exec'), 3);
    const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'x' });
    assert.ok(blocked);
    assert.match(blocked, /\(missing command: foo\)/);
    const msg = formatToolLoopGuardMessage(blocked, 'exec');
    assert.match(msg, /未能启动/);
    assert.match(msg, /foo/);
    assert.match(msg, /装依赖或改命令/);
    assert.match(msg, /install the dependency or change the command/);
    return msg;
  };
  const named127 = runGuard('exit_code: 127\nsh: foo: not found\n');
  for (const named9009 of [WIN_HEADER, WIN_FIRSTLINE, 'exit_code: 9009\nsh: foo: not found\n']) {
    assert.equal(parseMissingCommandName(named9009), 'foo');
    assert.equal(
      runGuard(named9009),
      named127,
      'named native CMD 9009 copy must equal named 127 copy'
    );
  }
  // Forged name (>64 chars) → parseMissingCommandName undefined → generic copy, no leak.
  const forged = `exit_code: 9009\nsh: ${'a'.repeat(65)}: not found\n`;
  assert.equal(parseMissingCommandName(forged), undefined);
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, forged, { command: 'x' }, 'win32');
  }
  const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'x' });
  assert.ok(blocked);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.match(msg, /未能启动/);
  assert.ok(!msg.includes('a'.repeat(65)));
  assert.doesNotMatch(msg, /装依赖或改命令/);
});

test('B: non-win32 + 9009 x3 → normal_nonzero; byToolFailure 0; no launch-failure copy', () => {
  const state = createToolLoopGuardState();
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(state, 'exec', true, WIN_HEADER, { command: 'foo' }, 'linux');
  }
  assert.equal(state.byToolFailure.get('exec') ?? 0, 0, '9009 on non-win32 must not count');
  // Same-command identical-output streak still hints (O96), but as a repeated
  // check — never 未能启动 / failed to start, and no global STOP.
  const blocked = shouldShortCircuitToolCall(state, 'exec', { command: 'foo' });
  assert.ok(blocked);
  assert.match(blocked, /same check failed repeatedly/i);
  const msg = formatToolLoopGuardMessage(blocked, 'exec');
  assert.doesNotMatch(msg, /未能启动|failed to start/i);
  assert.doesNotMatch(msg, /STOP calling|工具不可用/);
});
