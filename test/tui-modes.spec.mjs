#!/usr/bin/env node
/**
 * CLI shell interaction modes (target-spec §E, §F9–F11, §A7):
 *
 *   · `!` shell mode — prompt glyph, both rules and the hint row change, Enter
 *     runs the command inline through `runLocalShellCommand` and commits a
 *     `user` echo + a `result` row, Esc cancels.
 *   · shift+tab cycles the REAL policy layer (`cli/interaction-mode.ts`) —
 *     default → accept-edits → plan → default — never a parallel state.
 *   · the hint row always names the active mode, tinted per mode, and appends
 *     `(shift+tab to cycle)` to every non-default mode.
 *   · the advertised key/prefix tables only contain keys the shell routes.
 *
 * Projections are asserted directly; the component is driven through
 * ink-testing-library so the keyboard paths are the real ones.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import stringWidth from 'string-width';

import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import {
  INTERACTION_MODE_TONES,
  RESULT_MARK,
  SHELL_MODE_TONE,
  USER_MARK,
  interactionModeHint,
  renderHint,
  renderTranscriptRow,
} from '../dist/cli/tui/transcript.js';
import { HELP_KEYS, HELP_PREFIXES } from '../dist/cli/tui/help.js';
import { INTERACTION_MODE_CYCLE, TuiAppRoot, nextInteractionMode } from '../dist/cli/tui/app.js';
import {
  getCliInteractionMode,
  parseCliInteractionMode,
  setCliInteractionMode,
} from '../dist/cli/interaction-mode.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cells = (value) => stringWidth(value);
const text = (lines) => lines.map((entry) => entry.text).join('\n');

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

// ─── 1. projections: hint row names the mode, tinted per mode ────────────────

{
  const base = { running: false, tokens: 0, taskCount: 0, queueLength: 0 };

  // F10: only a non-default mode advertises the cycle key.
  // v0.26 T01 (PRD 2026-10-08): 'default' renamed to 'manual' — manual is a
  // non-default mode now (full is default) so it carries the cycle suffix.
  // Full four-state badge/cycle assertions land with T02 (W1b).
  assert.match(interactionModeHint('manual'), /manual mode on \(shift\+tab to cycle\)$/);
  assert.match(interactionModeHint('acceptEdits'), /accept-edits mode on \(shift\+tab to cycle\)$/);
  assert.match(interactionModeHint('plan'), /plan mode on \(shift\+tab to cycle\)$/);
  assert.match(interactionModeHint('full'), /full mode on$/);

  const hints = {};
  for (const mode of ['manual', 'acceptEdits', 'plan', 'full']) {
    const hint = renderHint({ ...base, mode }, 100);
    hints[mode] = hint;
    assert.ok(
      hint.text.includes(interactionModeHint(mode)),
      `A7: ${mode} is named in the hint row (${JSON.stringify(hint.text)})`
    );
    assert.ok(hint.text.includes('? for shortcuts'), `the hint still advertises ? (${mode})`);
    assert.equal(
      hint.color,
      INTERACTION_MODE_TONES[mode],
      `F11: ${mode} uses its own colour (${hint.color})`
    );
    assert.ok(cells(hint.text) <= 100, `the hint never overflows (${mode})`);
  }
  assert.equal(hints.plan.color, 'cyan', 'plan stays cyan');
  assert.equal(hints.acceptEdits.color, 'magenta', 'accept-edits stays magenta');
  assert.equal(hints.full.color, 'gray', 'full is quiet gray, not a yellow footer');

  // The tint is on the row, so a mode change is visible even while typing.
  assert.equal(
    renderHint({ ...base }, 100).color,
    'gray',
    'an omitted mode is the factory-default (full) and stays quiet'
  );

  // Shell mode: the reference hint text, the shell accent, and the mode intact.
  const shellHint = renderHint({ ...base, mode: 'plan', shellMode: true }, 100);
  assert.ok(shellHint.text.includes('! for shell mode'), 'E3: the shell hint is advertised');
  assert.ok(shellHint.text.includes('Esc to cancel'), 'the honest way out is advertised');
  assert.ok(shellHint.text.includes(interactionModeHint('plan')), 'A7 holds in shell mode too');
  assert.equal(shellHint.color, SHELL_MODE_TONE, 'the shell hint uses the shell accent');
  assert.ok(cells(shellHint.text) <= 100, 'the shell hint never overflows');
}

// ─── 2. projections: the shell echo and its result row ──────────────────────

{
  const echo = renderTranscriptRow({ id: 1, kind: 'user', text: '! ls -la demo' }, 90);
  const echoText = text(echo);
  assert.ok(echoText.includes('! ls -la demo'), 'E4: the command is echoed verbatim');
  assert.ok(!echoText.includes(USER_MARK), 'the ❯ mark is replaced in shell mode');
  const marked = echo.find((entry) => entry.text.startsWith('! '));
  assert.equal(marked?.color, SHELL_MODE_TONE, 'the echo carries the shell accent');

  // A normal goal keeps the old shape exactly.
  const goal = renderTranscriptRow({ id: 2, kind: 'user', text: 'stream the camera' }, 90);
  assert.ok(text(goal).includes(`${USER_MARK} stream the camera`), 'goals still carry ❯');
  assert.equal(goal[1].color, undefined, 'goals are not shell-tinted');

  const result = renderTranscriptRow({ id: 3, kind: 'result', text: 'demo\nnotes.md' }, 90);
  assert.ok(text(result).includes(`${RESULT_MARK}  demo`), 'E4: output is a ⎿ result row');
  assert.ok(text(result).includes('notes.md'), 'the whole output stays in the row');
}

// ─── 3. the cycle is the policy layer's vocabulary, in reference order ──────

{
  assert.deepEqual(
    [...INTERACTION_MODE_CYCLE],
    ['manual', 'acceptEdits', 'plan', 'full'],
    'F9 v0.26 (PRD W1): the four-state cycle covers every real interaction mode'
  );
  // Guards against inventing a parallel state: every cycle member must be
  // accepted by the policy layer's own parser.
  for (const mode of INTERACTION_MODE_CYCLE) {
    assert.equal(parseCliInteractionMode(mode), mode, `${mode} is a real policy mode`);
  }
  const seen = [];
  let mode = 'manual';
  for (let i = 0; i < 4; i++) {
    mode = nextInteractionMode(mode);
    seen.push(mode);
  }
  assert.deepEqual(
    seen,
    ['acceptEdits', 'plan', 'full', 'manual'],
    'four shift+tab presses walk manual → accept-edits → plan → full → manual (PRD W1 四态循环)'
  );
  // Four presses from ANY starting mode return to the start: the cycle wraps.
  for (const start of INTERACTION_MODE_CYCLE) {
    let walked = start;
    for (let i = 0; i < 4; i++) walked = nextInteractionMode(walked);
    assert.equal(walked, start, `four presses from ${start} return to ${start}`);
  }
}

// ─── 3b. read-only ceiling vs plan: the two non-full ceilings differ (W1) ────

{
  // PRD decision 2 / design §1.2: the read-only ceiling blocks EVERY non-readonly
  // side effect (including runtime_state); plan allows readonly + planMode:allow
  // helpers (todo_write/ask_user_question) while denying device_mutation and
  // plain mutations. The two mechanisms must stay distinct.
  const { describeCliToolApproval, isAllowedDuringPlanMode } =
    await import('../dist/cli/approval.js');
  const mkTool = (name, sideEffectClass, planMode) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass, ...(planMode ? { planMode } : {}) },
    execute: async () => 'ok',
  });
  // plan mode: readonly passes the class gate.
  assert.equal(
    isAllowedDuringPlanMode(mkTool('read_file', 'readonly', undefined), 'readonly'),
    true,
    'plan allows readonly side effects'
  );
  // plan mode: planMode allow helpers pass.
  assert.equal(
    isAllowedDuringPlanMode(mkTool('todo_write', 'runtime_state', 'allow'), 'runtime_state'),
    true,
    'plan allows planMode:allow runtime_state helpers'
  );
  // plan mode: device_mutation is class-denied even with planMode allow.
  assert.equal(
    isAllowedDuringPlanMode(mkTool('device_exec', 'device_mutation', 'allow'), 'device_mutation'),
    false,
    'plan denies device_mutation even with planMode allow (class-level)'
  );
  // read-only ceiling (describeCliToolApproval with mode read-only): every
  // non-readonly side effect is blocked, including runtime_state — STRICTER
  // than plan, which lets runtime_state through via planMode allow.
  const runtimePreview = describeCliToolApproval(
    { tool: mkTool('todo_write', 'runtime_state', 'allow'), input: {} },
    'read-only',
    {},
    {}
  );
  assert.ok(
    /Blocked by read-only/.test(runtimePreview.decisionContext),
    `read-only ceiling blocks runtime_state (stricter than plan): ${runtimePreview.decisionContext}`
  );
  const readonlyPreview = describeCliToolApproval(
    { tool: mkTool('read_file', 'readonly', undefined), input: {} },
    'read-only',
    {},
    {}
  );
  assert.ok(
    !/Blocked by/.test(readonlyPreview.decisionContext),
    `read-only ceiling still lets readonly tools through: ${readonlyPreview.decisionContext}`
  );
}

// ─── 4. component: `!` mode, inline execution, Esc, shift+tab, help ─────────

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-modes-'));
const streamCalls = [];

const agent = {
  asyncTasks: { list: () => [] },
  async *streamChat(sessionKey, message) {
    streamCalls.push({ sessionKey, message });
    yield { type: 'text_delta', delta: 'ack' };
    yield { type: 'done', result: { response: 'ack', stopReason: 'end_turn' } };
  },
};

setCliInteractionMode('manual');
const listeners = new Set();
const handle = {
  store: createTuiStore(),
  notify: () => {
    for (const l of listeners) l();
  },
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const runtime = new TaskRuntime({ workspaceDir: ws });
const instance = renderInk(
  React.createElement(TuiAppRoot, {
    options: {
      agent,
      workspaceDir: ws,
      model: 'model-x',
      version: '0.22.0',
      listSessions: async () => [],
      mcpServers: [],
      listCheckpoints: () => [],
    },
    handle,
    runtime,
  })
);

const frame = () => instance.lastFrame();
const rowsOf = (kind) => handle.store.rows.filter((row) => row.kind === kind);
const typeOnly = async (value) => {
  for (const ch of value) {
    instance.stdin.write(ch);
    await sleep(12);
  }
  await sleep(80);
};
const hintRow = () => frame().trimEnd().split('\n').pop() ?? '';

assert.ok(await waitFor(() => rowsOf('banner').length === 1), 'the shell boots');
assert.ok(hintRow().includes('manual mode on'), `boot hint names the mode: ${hintRow()}`);

// 4a. Typing `!` alone enters shell mode: the glyph, the glyph+placeholder line
// and the hint row all change, exactly like the reference capture.
await typeOnly('!');
assert.ok(
  frame().includes('! for shell mode'),
  `E1/E3: typing ! enters shell mode: ${JSON.stringify(frame().slice(-300))}`
);
const placeholderLine = frame()
  .split('\n')
  .find((line) => line.includes('Try "stream the camera'));
assert.ok(
  placeholderLine?.startsWith('! '),
  `E2: the prompt glyph becomes ! (${JSON.stringify(placeholderLine)})`
);
assert.ok(hintRow().includes('! for shell mode'), 'the hint row switches to shell mode');
assert.ok(!frame().includes('❯'), 'the ❯ prompt is gone while in shell mode');

// 4b. Esc cancels: nothing runs, the composer goes back to normal.
await typeOnly('echo never-runs');
assert.ok(frame().includes('! echo never-runs'), 'the command is echoed inside shell mode');
instance.stdin.write('\x1b');
await sleep(120);
assert.ok(!frame().includes('! for shell mode'), 'Esc cancels shell mode');
assert.ok(hintRow().includes('manual mode on'), 'the hint row returns to the mode label');
assert.ok(!frame().includes('! echo never-runs'), 'Esc discards the cancelled draft');
assert.equal(rowsOf('user').length, 0, 'Esc committed no user row');
assert.equal(rowsOf('result').length, 0, 'Esc executed nothing');

// 4c. Enter runs the command inline: a `! <cmd>` echo plus the real output as a
// `result` row, and NO model turn.
const before = streamCalls.length;
await typeOnly('!');
await typeOnly('echo moss-shell-mode');
assert.ok(hintRow().includes('! for shell mode'), 'still in shell mode while typing the command');
instance.stdin.write('\r');
assert.ok(
  await waitFor(() => rowsOf('result').some((row) => row.text.includes('moss-shell-mode'))),
  `E4: the command output lands in the transcript: ${JSON.stringify(
    rowsOf('result').map((row) => row.text)
  )}`
);
assert.ok(
  rowsOf('user').some((row) => row.text === '! echo moss-shell-mode'),
  'E4: the echo is committed as `! <cmd>`'
);
assert.equal(streamCalls.length, before, 'a shell command does not start a model turn');
assert.ok(
  await waitFor(() => !frame().includes('! for shell mode')),
  'the composer returns to normal after the run'
);
assert.ok(hintRow().includes('manual mode on'), 'the hint row returns to the mode label');

// 4d. A batched chunk (`!pwd` in ONE write, i.e. a paste/fast typing) still
// enters shell mode — ink delivers multi-character input in one keypress.
instance.stdin.write('!pwd');
await sleep(150);
assert.ok(
  frame().includes('! pwd') && hintRow().includes('! for shell mode'),
  `a batched !cmd enters shell mode: ${JSON.stringify(frame().slice(-200))}`
);
instance.stdin.write('\x1b');
await sleep(120);
assert.ok(!frame().includes('! for shell mode'), 'Esc leaves the batched draft too');

// 4e. shift+tab cycles the policy layer and repaints the hint immediately.
// v0.26 (PRD W1): four states, so four presses visit all of them and the
// fifth returns to the start. The badge follows PRD decision 4 — the DEFAULT
// mode (full) has no suffix; every non-default mode carries
// `(shift+tab to cycle)`.
const cycle = [
  ['acceptEdits', 'accept-edits mode on (shift+tab to cycle)'],
  ['plan', 'plan mode on (shift+tab to cycle)'],
  ['full', 'full mode on'],
  ['manual', 'manual mode on (shift+tab to cycle)'],
];
for (const [expected, label] of cycle) {
  instance.stdin.write('\x1b[Z'); // CSI Z = shift+tab
  await sleep(150);
  assert.equal(getCliInteractionMode(), expected, `shift+tab → ${expected}`);
  assert.ok(
    hintRow().includes(label),
    `the hint shows "${label}" on the next frame: ${JSON.stringify(hintRow())}`
  );
}
// One more turn of the cycle proves it wraps rather than sticking.
instance.stdin.write('\x1b[Z');
await sleep(150);
assert.equal(getCliInteractionMode(), 'acceptEdits', 'the cycle wraps back around');
assert.ok(hintRow().includes('(shift+tab to cycle)'), 'a non-default mode advertises the key');
setCliInteractionMode('full');
await sleep(120);
assert.ok(
  !hintRow().includes('(shift+tab to cycle)'),
  'v0.26 decision 4: full (the default) drops the suffix'
);
assert.ok(hintRow().includes('full mode on'), 'full names itself in the hint');
setCliInteractionMode('manual');
await sleep(120);
assert.ok(
  hintRow().includes('(shift+tab to cycle)'),
  'manual is non-default (full is default) so it carries the suffix'
);

// 4f. The advertised surface is real: every prefix is documented and routed,
// and the key table names the two new keys.
for (const prefix of ['!', '/', '@']) {
  assert.ok(
    HELP_PREFIXES.some(([value]) => value === prefix),
    `E6: the ${prefix} prefix is documented`
  );
}
assert.equal(HELP_PREFIXES.length, 3, 'E6: exactly three input prefixes are documented');
assert.ok(
  HELP_KEYS.some(([keys]) => keys === 'Shift+Tab'),
  'the cycle key is in the advertised key table'
);
assert.ok(
  HELP_KEYS.some(([keys, what]) => keys === '!' && /shell/.test(what)),
  'the shell prefix is in the advertised key table'
);

instance.stdin.write('?');
assert.ok(
  await waitFor(() => frame().includes('prefixes')),
  'the help block documents the prefixes'
);
const shortcuts = frame();
assert.ok(shortcuts.includes('prefixes'), 'the help overlay includes the prefix section');
assert.ok(shortcuts.includes('shortcuts'), 'the help overlay includes the shortcut section');

instance.unmount();
await sleep(150);

console.log('[PASS] TUI interaction modes (bash mode / shift+tab cycle / hint mode)');
