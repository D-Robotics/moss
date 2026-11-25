#!/usr/bin/env node
/**
 * TUI interaction probe: the pure projections behind the queue rows, the
 * transcript search, the keymap and `/copy`.
 *
 * The end-to-end half (a real PTY, real keys, the painted screen) lives in
 * scripts/verify/tui-interaction.py (stdlib, runs in this gate) and in
 * scripts/tui-feel/assert-interaction.py (pyte, opt-in). This file pins the
 * data shapes so a wiring change fails with the row that changed, not with a
 * blank screen.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the last stderr line meaningful: the verify runner prints only that.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (error) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[tui-interaction] ${signal}: ${text.replace(/\n/g, ' ⏎ ')}`);
    process.exit(1);
  });
}

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const queueView = await load('dist/cli/tui/queue-view.js');
const copy = await load('dist/cli/tui/copy.js');
const text = await load('dist/cli/tui/text.js');
const catalog = await load('dist/cli/interactive-commands.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[tui-interaction] ok ${name}`);
};
const texts = (lines) => lines.map((entry) => entry.text);

// ── queue rows ─────────────────────────────────────────────────────────────

assert.deepEqual(queueView.renderQueueChrome([], { width: 80, running: true, paused: true }), []);
ok('an empty queue paints nothing');

const queued = ['first', 'second', 'third'].map((display) => ({ display, text: display }));
const idle = texts(
  queueView.renderQueueChrome(queued, { width: 80, running: false, paused: false })
);
assert.deepEqual(idle, [
  '  queued 1. first',
  '  queued 2. second',
  '  queued 3. third',
  '  Alt+↑ edits the newest · ↑ when the composer is empty',
]);
const running = texts(
  queueView.renderQueueChrome(queued, { width: 80, running: true, paused: false })
);
assert.equal(running.length, idle.length + 1);
assert.match(running.at(-1), /applies when this run finishes/);
ok('queued rows count from 1 and the running wait is the last row');

const seven = Array.from({ length: 7 }, (_, index) => ({ display: `item ${index + 1}`, text: '' }));
const folded = texts(
  queueView.renderQueueChrome(seven, { width: 80, running: false, paused: false })
);
assert.deepEqual(
  folded.slice(0, 5),
  [1, 2, 3, 4, 5].map((n) => `  queued ${n}. item ${n}`)
);
assert.equal(folded[5], '  … +2 more queued — /queue to list');
assert.ok(!folded.some((row) => row.includes('item 6')), 'the sixth item stays off the rows');
const tighter = texts(
  queueView.renderQueueChrome(seven, { width: 80, running: false, paused: false, limit: 2 })
);
assert.equal(tighter[2], '  … +5 more queued — /queue to list');
ok('more than five queued rows fold into one +N row');

const paused = texts(
  queueView.renderQueueChrome(queued, { width: 80, running: true, paused: true })
);
assert.equal(paused[0], '  Queue paused — /queue resume');
assert.equal(
  queueView.renderQueueChrome(queued, { width: 80, running: true, paused: true })[0].color,
  'yellow'
);
ok('a paused queue says so on its first row');

const multi = queueView.renderQueueChrome([{ display: 'one   line\nbreak  here', text: '' }], {
  width: 80,
  running: false,
  paused: false,
});
assert.equal(multi[0].text, '  queued 1. one line break here');
const long = queueView.renderQueueChrome([{ display: 'x'.repeat(200), text: '' }], {
  width: 24,
  running: false,
  paused: false,
});
assert.ok(
  long.every((entry) => text.displayWidth(entry.text) <= 24),
  'no row is wider than the frame'
);
ok('queued rows collapse whitespace and fit the width');

// ── /queue arguments ───────────────────────────────────────────────────────

assert.deepEqual(queueView.parseQueueCommand(''), { kind: 'list' });
assert.deepEqual(queueView.parseQueueCommand('list'), { kind: 'list' });
for (const sub of ['pause', 'resume', 'drop', 'clear']) {
  assert.deepEqual(queueView.parseQueueCommand(sub), { kind: sub });
  assert.deepEqual(queueView.parseQueueCommand(`  ${sub.toUpperCase()} `), { kind: sub });
}
assert.deepEqual(queueView.parseQueueCommand('fix the tests'), {
  kind: 'enqueue',
  text: 'fix the tests',
});
assert.deepEqual(queueView.parseQueueCommand('  drop it now '), { kind: 'drop' });
assert.deepEqual(queueView.parseQueueCommand('pause the build'), { kind: 'pause' });
ok('/queue parses its five subcommands and queues anything else');

const queueRow = catalog.INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows).find(
  (row) => row.command === '/queue'
);
assert.equal(queueRow.hidden, undefined, '/queue is in the everyday menu');
assert.deepEqual([...queueRow.surfaces], ['tui']);
assert.equal(queueRow.availableDuringRun, 'immediate');
assert.match(queueRow.args, /follow-up/);
ok('the catalog advertises /queue on the TUI surface, mid-run');

// ── recall and interrupt ───────────────────────────────────────────────────

const empty = [];
assert.equal(queueView.recallQueuedInput(empty, 'draft'), undefined);
// The queue drains from its head (`shift`), so the tail is the newest line.
const recall = [
  { display: 'oldest', text: 'oldest' },
  { display: 'newest', text: 'newest' },
];
assert.equal(queueView.recallQueuedInput(recall, ''), 'newest');
assert.equal(recall.length, 1);
assert.equal(queueView.recallQueuedInput(recall, 'typed  '), 'oldest\ntyped');
assert.equal(recall.length, 0);
ok('Alt+↑ takes the newest queued line and keeps the draft below it');

const back = [
  { display: 'a', text: 'a' },
  { display: 'b', text: 'b' },
];
assert.equal(queueView.returnQueueToDraft(back, ''), 'a\nb');
assert.equal(back.length, 0);
const keep = [{ display: 'a', text: 'a' }];
assert.equal(queueView.returnQueueToDraft(keep, 'draft'), 'a\ndraft');
assert.equal(keep.length, 0);
const untouched = [];
assert.equal(queueView.returnQueueToDraft(untouched, 'draft'), 'draft');
ok('Esc returns every queued line into the composer, draft last');

// ── zh chrome ──────────────────────────────────────────────────────────────

copy.setTuiLocale(true);
try {
  const zh = texts(queueView.renderQueueChrome(queued, { width: 80, running: true, paused: true }));
  assert.equal(zh[0], '  队列已暂停 — /queue resume');
  assert.equal(zh[1], '  排队 1. first');
  assert.match(zh.at(-2), /Alt\+↑ 编辑最新一条/);
  for (const key of [
    'Queue paused — /queue resume',
    '… +{count} more queued — /queue to list',
    'Alt+↑ edits the newest · ↑ when the composer is empty',
    'queue a follow-up for after the run, or inspect and control the input queue',
    'keys the composer keeps',
    'changed from the defaults',
    'problems',
    '  Keys · Esc to close',
    'edit the newest queued message',
    'show every shortcut, the keys the composer keeps, and keybinding problems',
    'copied the last answer ({count} chars)',
    'no answer to copy yet',
    'copy the last answer to the clipboard, as markdown',
  ]) {
    const value = copy.ZH[key];
    assert.ok(value && value.length > 0, `${key} has a zh string`);
    assert.notEqual(value, key, `${key} translates to something else`);
  }
} finally {
  copy.setTuiLocale(false);
}
ok('the queue chrome and the catalog row read in Chinese too');

// ── keymap ─────────────────────────────────────────────────────────────────

const keymap = await load('dist/cli/tui/keymap.js');
const helpers = await load('dist/cli/tui/app-helpers.js');

assert.equal(keymap.parseKeySpec('Alt+Up'), 'alt+up');
assert.equal(keymap.parseKeySpec(' Shift + CTRL + f '), 'ctrl+shift+f');
assert.equal(keymap.parseKeySpec('ctrl+Return'), 'ctrl+enter', 'return is an accepted spelling');
assert.equal(keymap.parseKeySpec('PageDown'), 'pagedown');
assert.equal(keymap.parseKeySpec('ctrl+enter'), 'ctrl+enter');
assert.equal(keymap.parseKeySpec('alt+8'), 'alt+8');
for (const bad of [
  'r',
  'shift+r',
  'enter',
  'Return',
  'tab',
  'escape',
  'ctrl+ctrl+f',
  'hyper+f',
  'ctrl+foo',
  'f3',
  '',
  'ctrl+',
]) {
  assert.equal(keymap.parseKeySpec(bad), undefined, `"${bad}" is not a key the shell can bind`);
}
ok('a key is ctrl/alt/shift + a letter, a digit or a named key; typing keys alone are refused');

// A bare arrow is a well-formed key, but the viewport owns it: the defaults
// never claim it and keybindings.json cannot hand it to a command.
assert.equal(keymap.parseKeySpec('up'), 'up');

assert.equal(keymap.keyEventSpec({ shift: true }, 'R'), undefined, 'a shifted letter is text');
assert.equal(keymap.keyEventSpec({}, 'r'), undefined, 'a letter is text');
assert.equal(keymap.keyEventSpec({ upArrow: true, meta: true }, ''), 'alt+up');
assert.equal(keymap.keyEventSpec({ upArrow: true, shift: true }, ''), 'shift+up');
// Shift+Tab changes the interaction mode before the registry is read, and a
// tab with no ctrl/alt is not a bindable key at all.
assert.equal(keymap.keyEventSpec({ tab: true, shift: true }, ''), undefined);
assert.equal(keymap.keyEventSpec({ return: true, ctrl: true }, ''), 'ctrl+enter');
assert.equal(keymap.keyEventSpec({ ctrl: true }, 'f'), 'ctrl+f');
assert.equal(keymap.keyEventSpec({ pageUp: true }, ''), 'pageup');
ok('an ink key event becomes the same canonical key, or nothing when it is text');

const defaults = keymap.loadKeybindings(undefined);
assert.deepEqual(defaults.warnings, []);
assert.equal(keymap.commandForKey(defaults.bindings, 'alt+up'), 'queue.recall');
const defaultKeys = defaults.bindings.flatMap((entry) => entry.keys);
assert.equal(new Set(defaultKeys).size, defaultKeys.length, 'no two defaults share a key');
for (const reserved of keymap.RESERVED_KEYS) {
  assert.equal(
    keymap.commandForKey(defaults.bindings, reserved),
    undefined,
    `the defaults never claim ${reserved}`
  );
}
ok('the defaults leave every composer key alone');

const custom = keymap.loadKeybindings(
  JSON.stringify({
    'history.search': ['ctrl+t', 'alt+r'],
    'composer.clear': 'alt+8',
    'draft.stash': 'enter',
    'edit.killLineEnd': 'up',
    'editor.external': 'shift+pageup',
    'view.toggleVerbose': ['ctrl+o', 'x'],
    'run.interrupt': 'ctrl+x',
    'nope.nope': 'ctrl+x',
    'caret.lineStart': 'ctrl+e',
  })
);
assert.deepEqual(custom.bindings.find((entry) => entry.command === 'history.search').keys, [
  'ctrl+t',
  'alt+r',
]);
assert.equal(keymap.commandForKey(custom.bindings, 'alt+r'), 'history.search');
assert.equal(keymap.commandForKey(custom.bindings, 'alt+8'), 'composer.clear');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+l'), undefined, 'composer.clear moved');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+o'), 'view.toggleVerbose');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+s'), 'draft.stash');
assert.equal(keymap.commandForKey(custom.bindings, 'up'), undefined, 'the viewport keeps ↑');
assert.equal(
  keymap.commandForKey(custom.bindings, 'shift+pageup'),
  undefined,
  'and PgUp with any modifier'
);
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+g'), 'editor.external');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+k'), 'edit.killLineEnd');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+c'), 'run.interrupt');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+e'), 'caret.lineStart');
assert.equal(keymap.commandForKey(custom.bindings, 'ctrl+a'), undefined);
assert.ok(!custom.bindings.some((entry) => entry.command === 'caret.lineEnd'));
for (const fragment of [
  'unknown command "nope.nope"',
  'run.interrupt cannot be rebound',
  'is a key the composer already answers',
  'is not a key this shell reads',
  'bound to both caret.lineStart and caret.lineEnd',
  'caret.lineEnd has no key left',
]) {
  assert.ok(
    custom.warnings.some((warning) => warning.includes(fragment)),
    `says: ${fragment}`
  );
}
ok('keybindings.json takes a key or a list, and every problem becomes a warning');

const legacy = keymap.loadKeybindings('{"history.search": "ctrl+t"}');
assert.deepEqual(legacy.bindings.find((entry) => entry.command === 'history.search').keys, [
  'ctrl+t',
]);
ok('a keybindings.json written for the old single-key form still applies');

const rows = keymap.shortcutRows(defaults.bindings);
assert.equal(rows.find((row) => row.label === 'edit the newest queued message').keys, 'Alt+↑');
assert.equal(rows.find((row) => row.label === 'search your earlier prompts').keys, 'Ctrl+R');
const customRows = keymap.shortcutRows(custom.bindings);
assert.equal(customRows.find((row) => row.label === 'search your earlier prompts').keys, 'Ctrl+T');
ok('help prints the first key of each command');

const hot = helpers.buildHotkeyLines(defaults.bindings, defaults.warnings);
assert.match(hot[0], /shortcuts/);
assert.match(
  hot.find((row) => row.includes('caret to line start')),
  /^ {2}Ctrl\+A\s+caret/
);
assert.match(
  hot.find((row) => row.includes('insert a new line')),
  /^ {2}Shift\+Enter \/ Ctrl\+J\s+insert a new line$/
);
assert.ok(
  hot.some((row) => row.includes('keybindings.json')),
  'it says where to rebind'
);
assert.ok(!hot.includes('problems'), 'no problems section without problems');
const hotCustom = helpers.buildHotkeyLines(custom.bindings, custom.warnings);
assert.ok(
  hotCustom.some((row) => row.startsWith('  history.search  Ctrl+R → Ctrl+T / Alt+R')),
  'it shows what moved'
);
assert.equal(hotCustom[0], 'problems', 'the problems come first, inside the first screen');
assert.ok(hotCustom.some((row) => row.includes('caret.lineEnd has no key left')));
ok('/hotkeys lists every key, what moved, and every problem');

const hotkeysRow = catalog.INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows).find(
  (row) => row.command === '/hotkeys'
);
assert.equal(hotkeysRow.hidden, undefined, '/hotkeys is in the everyday menu');
assert.deepEqual([...hotkeysRow.surfaces], ['tui']);
assert.equal(hotkeysRow.availableDuringRun, 'immediate');
ok('the catalog advertises /hotkeys on the TUI surface, mid-run');

// ── /copy ──────────────────────────────────────────────────────────────────

// `/copy` reads the same rows the transcript paints, so build them the way
// render-bridge does: a fresh answer block, `progress` narration, and
// `continuation` paragraphs.
const transcriptRow = (kind, text, extra = {}) => ({ id: 0, kind, text, ...extra });

assert.equal(helpers.lastAnswerText([]), undefined);
assert.equal(helpers.lastAnswerText([transcriptRow('user', 'hello')]), undefined);
assert.equal(
  helpers.lastAnswerText([transcriptRow('assistant', 'Let me look.', { progress: true })]),
  undefined,
  'narration alone is not an answer'
);
ok('/copy has nothing to copy before the first answer');

const answer = 'Use `npm run check`.\n\n```sh\nnpm run check\n```';
assert.equal(
  helpers.lastAnswerText([
    transcriptRow('user', 'how do I verify?'),
    transcriptRow('assistant', 'Let me look at the scripts.', { progress: true }),
    transcriptRow('tool', 'read_file'),
    transcriptRow('result', 'Read 12 lines'),
    transcriptRow('assistant', answer),
  ]),
  answer,
  'the answer is copied as markdown source, without the narration'
);
ok('/copy copies the newest answer as markdown source');

const summary = { text: 'Compacted 2 turns' };
assert.equal(
  helpers.lastAnswerText([
    transcriptRow('assistant', answer),
    transcriptRow('summary', summary.text),
    transcriptRow('system', 'resumed'),
  ]),
  answer,
  'rows after the answer do not hide it'
);
assert.equal(
  helpers.lastAnswerText([
    transcriptRow('assistant', 'First draft.', { progress: true }),
    transcriptRow('assistant', 'The real answer.'),
    transcriptRow('assistant', 'Second paragraph.', { continuation: true }),
  ]),
  'The real answer.\n\nSecond paragraph.',
  'a superseded block stays out, the continuation paragraphs come along'
);
assert.equal(
  helpers.lastAnswerText([transcriptRow('assistant', '   \n ')]),
  undefined,
  'a blank block is not an answer'
);
ok('/copy follows the answer across later rows and superseded blocks');

const copyRow = catalog.INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows).find(
  (row) => row.command === '/copy'
);
assert.equal(copyRow.hidden, undefined, '/copy is in the everyday menu');
assert.deepEqual([...copyRow.surfaces], ['tui']);
assert.equal(copyRow.availableDuringRun, 'immediate');
ok('the catalog advertises /copy on the TUI surface, mid-run');

console.log(`[tui-interaction] ${String(checks)} checks passed`);
