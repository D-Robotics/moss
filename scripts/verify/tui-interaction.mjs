#!/usr/bin/env node
/**
 * TUI interaction probe: the pure projections behind the queue rows, the
 * transcript search, the keymap, and `/copy`'s choice and running of the
 * session's clipboard tool.
 *
 * The end-to-end half (a real PTY, real keys, the painted screen) lives in
 * scripts/verify/tui-interaction.py (stdlib, off the clock: the stage runs
 * it with VERIFY_TUI_PTY=1) and in scripts/tui-feel/assert-interaction.py
 * (pyte, opt-in). This file pins the data shapes so a wiring change fails
 * with the row that changed, not with a blank screen.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

// ── transcript search ──────────────────────────────────────────────────────

const search = await load('dist/cli/tui/search.js');
const viewport = await load('dist/cli/tui/viewport.js');

assert.equal(search.visibleText('plain'), 'plain');
assert.equal(search.visibleText('\x1b[1mbold\x1b[0m'), 'bold');
assert.equal(
  search.visibleText('\x1b]8;;https://x.dev\x1b\\link text\x1b]8;;\x07after'),
  'link textafter'
);
assert.equal(search.visibleText('a\x1b'), 'a');
ok('visible text drops CSI, OSC 8 hyperlinks and a dangling escape');

const lines = ['RDK X5 is a board.', 'rdk x5 again', 'no board here', 'rdk x5'];
const spans = (found) => found.map(({ line, start, end }) => [line, start, end]);
assert.deepEqual(spans(search.findMatches(lines, 'rdk x5')), [
  [0, 0, 6],
  [1, 0, 6],
  [3, 0, 6],
]);
assert.deepEqual(
  spans(search.findMatches(lines, 'RDK  X5')),
  spans(search.findMatches(lines, 'rdk x5'))
);
assert.deepEqual(spans(search.findMatches(lines, 'board')), [
  [0, 12, 17],
  [2, 3, 8],
]);
assert.deepEqual(search.findMatches(lines, 'again no board'), [], 'a hit sits on one line');
assert.deepEqual(search.findMatches(lines, ''), []);
assert.deepEqual(search.findMatches(lines, '   '), []);
assert.deepEqual(spans(search.findMatches(['rdk x5 rdk x5'], 'RDK')), [
  [0, 0, 3],
  [0, 7, 10],
]);
ok('find is literal and case-insensitive, every hit carries its line and offsets');

// Offsets are UTF-16 positions and a character that lowercases to several
// units must not shift the ones after it.
assert.deepEqual(spans(search.findMatches(['İstanbul x'], 'X')), [[0, 9, 10]]);
assert.deepEqual(spans(search.findMatches(['École x'], 'école')), [[0, 0, 5]]);
assert.deepEqual(spans(search.findMatches(['a 👍 b'], '👍')), [[0, 2, 4]]);
ok('offsets survive characters that fold wide or sit outside the BMP');

const marked = search.highlightMatch(text.line('read file.rs now'), 5, 12, true);
const runMarks = (painted) =>
  painted.runs.map((run) => [
    run.text,
    run.inverse === true,
    run.bold === true,
    run.underline === true,
  ]);
assert.deepEqual(runMarks(marked), [
  ['read ', false, false, false],
  ['file.rs', true, true, false],
  [' now', false, false, false],
]);
const styled = search.highlightMatch(
  text.line('read file.rs now', { color: 'cyan', bold: true }),
  5,
  12,
  false
);
assert.equal(styled.runs[1].color, 'cyan', 'a hit keeps its colour');
assert.equal(styled.runs[1].underline, true);
assert.equal(styled.runs[1].inverse, undefined, 'only the hit the reader is on is inverted');
const emoji = search.highlightMatch(text.line('a👍b'), 1, 3, true);
assert.deepEqual(runMarks(emoji).slice(1, 2), [['👍', true, true, false]]);
ok('a hit is underlined or inverted, on whole characters, without losing its style');

// A hyperlink is split around its label: the escapes stay, the label is marked.
const open = '\x1b]8;;https://x.dev\x1b\\';
const close = '\x1b]8;;\x1b\\';
const linked = {
  text: `see ${open}docs and${close} more`,
  runs: [
    { text: 'see ' },
    { text: `${open}docs and${close} `, color: 'cyan' },
    { text: 'more', italic: true },
  ],
};
const paintedLink = search.highlightMatch(linked, 4, 12, false);
assert.equal(paintedLink.text, linked.text, 'the line text is not rewritten');
assert.equal(
  search.visibleText(paintedLink.runs.map((run) => run.text).join('')),
  'see docs and more'
);
assert.equal(
  paintedLink.runs
    .filter((run) => run.underline)
    .map((run) => search.visibleText(run.text))
    .join(''),
  'docs and'
);
assert.ok(
  paintedLink.runs.some((run) => run.text.startsWith(open)),
  'the hyperlink opener is kept'
);
assert.ok(
  paintedLink.runs.some((run) => run.text.includes(close)),
  'the hyperlink closer is kept'
);
ok('a hit inside a hyperlink keeps the link and marks only its label');

const bar = search.renderTranscriptSearch('', -1, 0, 80);
assert.equal(bar[0].text, '⌕ ');
assert.equal(
  bar[1].text,
  '  type to search · Enter ↓ next · ↑ previous · Esc close · Ctrl+U clear'
);
// Every variant of the hint row fits 80 columns, so no key is ever clipped.
for (const variant of [
  bar,
  search.renderTranscriptSearch('x', 1, 3, 80),
  search.renderTranscriptSearch('needle', 0, 3, 80, true),
]) {
  assert.ok(!variant[1].text.includes('…'), `clipped at 80 columns: ${variant[1].text}`);
}
assert.equal(
  search.renderTranscriptSearch('needle', 0, 3, 80, true)[1].text,
  '  1 of 3 · Enter ↓ next · ↑ previous · type to replace · Esc close'
);
assert.match(search.renderTranscriptSearch('zz', -1, 0, 80)[1].text, /^ {2}no match · /);
assert.ok(search.renderTranscriptSearch('rdk', 1, 3, 80)[1].text.startsWith('  2 of 3 · '));
assert.ok(
  text.displayWidth(search.renderTranscriptSearch('q'.repeat(60), 0, 3, 40)[0].text) <= 40,
  'a long query is clipped to the width'
);
assert.deepEqual(helpers.inkTextStyle({ inverse: true }), { inverse: true });
ok('the bar shows the query, where the reader is, and the keys; inverse reaches ink');

// A resumed search shows its query selected: the text inverted, the glyph not.
const selectedBar = search.renderTranscriptSearch('needle', 0, 3, 80, true);
assert.equal(selectedBar[0].text, '⌕ needle');
assert.deepEqual(
  selectedBar[0].runs.map((run) => [run.text, run.inverse === true]),
  [
    ['⌕ ', false],
    ['needle', true],
  ]
);
assert.equal(search.renderTranscriptSearch('needle', 0, 3, 80)[0].runs, undefined);
// A paste cannot carry escapes or line breaks into the one-row query.
assert.equal(search.searchText('a\x1b[31mb\n c\x00d\u009be'), 'a[31mb cde');
ok('a resumed query is shown selected, and a paste loses its control characters');

copy.setTuiLocale(true);
try {
  assert.equal(
    search.renderTranscriptSearch('zz', -1, 0, 80)[1].text,
    '  没有匹配 · Enter ↓ 下一个 · ↑ 上一个 · Esc 关闭 · Ctrl+U 清空'
  );
  assert.equal(
    search.renderTranscriptSearch('x', 1, 3, 80)[1].text,
    '  第 2 个，共 3 个 · Enter ↓ 下一个 · ↑ 上一个 · Esc 关闭 · Ctrl+U 清空'
  );
  for (const key of [
    'search the transcript',
    'type to search',
    'Enter ↓ next · ↑ previous · type to replace · Esc close',
    'no match',
    '{n} of {count}',
    'Enter ↓ next · ↑ previous · Esc close · Ctrl+U clear',
    'find works in the fullscreen view',
  ]) {
    const value = copy.ZH[key];
    assert.ok(value && value.length > 0, `${key} has a zh string`);
    assert.notEqual(value, key, `${key} translates to something else`);
  }
} finally {
  copy.setTuiLocale(false);
}
ok('the search bar and its strings read in Chinese too');

assert.equal(keymap.commandForKey(defaults.bindings, 'ctrl+f'), 'view.search');
assert.equal(
  rows.find((row) => row.label === 'search the transcript').keys,
  'Ctrl+F',
  'the default help lists it'
);
ok('Ctrl+F opens the search and the help says so');

const vlines = Array.from({ length: 30 }, (_, index) => ({
  rowId: index,
  lineIndex: 0,
  text: `line ${index}`,
}));
const windowAt = (state, height) => viewport.viewportWindow(vlines, state, height);
const centred = windowAt(viewport.viewportAtLine(vlines, 10, 15), 10);
assert.deepEqual(
  [centred.start, centred.lines.length, centred.pinned, centred.lines[5].text],
  [10, 10, false, 'line 15'],
  'a hit with room on both sides lands in the middle of the window'
);
assert.equal(windowAt(viewport.viewportAtLine(vlines, 10, 0), 10).start, 0);
const atEnd = windowAt(viewport.viewportAtLine(vlines, 10, 29), 10);
assert.deepEqual(
  [atEnd.pinned, atEnd.start, atEnd.lines.length, atEnd.lines.at(-1).text],
  [true, 20, 10, 'line 29'],
  'a hit on the last line pins to the bottom, where that line is on screen'
);
const nearEnd = windowAt(viewport.viewportAtLine(vlines, 10, 17), 10);
assert.deepEqual(
  [nearEnd.pinned, nearEnd.start],
  [false, 12],
  'a hit with room below it is centred like any other'
);
// Five rows below the hit is the last row that still centres it (24 - 5 = 19).
const lastCentred = windowAt(viewport.viewportAtLine(vlines, 10, 24), 10);
assert.deepEqual(
  [lastCentred.pinned, lastCentred.start, lastCentred.lines[5].text, lastCentred.lines.length],
  [false, 19, 'line 24', 10],
  'a hit five rows above the end is the last row of an unpinned window'
);
const edge = windowAt(viewport.viewportAtLine(vlines, 10, 25), 10);
assert.deepEqual(
  [edge.pinned, edge.start, edge.lines[5].text],
  [true, 20, 'line 25'],
  'four rows above the end the window pins, hit still on screen'
);
const short = Array.from({ length: 5 }, (_, index) => ({ rowId: index, lineIndex: 0, text: '' }));
const tiny = viewport.viewportWindow(short, viewport.viewportAtLine(short, 10, 2), 10);
assert.deepEqual([tiny.pinned, tiny.start, tiny.lines.length], [true, 0, 5]);
// A taller transcript under the same state (an anchor keeps the reader in place).
const longer = Array.from({ length: 60 }, (_, index) => ({ rowId: index, lineIndex: 0, text: '' }));
assert.equal(
  viewport.viewportWindow(longer, viewport.viewportAtLine(vlines, 10, 15), 10).start,
  10
);
ok('a hit near the top, the bottom or a short transcript is still inside the window');

// ── /copy: which tools a session has, and what the status line says ───────

const clipboard = await load('dist/cli/tui/clipboard.js');
const toolsOf = (platform, env) =>
  clipboard.clipboardCommands(platform, env).map((tool) => [tool.command, ...tool.args]);
const x11 = [
  ['xclip', '-selection', 'clipboard'],
  ['xsel', '--clipboard', '--input'],
];
assert.deepEqual(toolsOf('darwin', {}), [['pbcopy']]);
assert.deepEqual(toolsOf('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), [
  ['wl-copy', '-t', 'text/plain'],
  ...x11,
]);
assert.deepEqual(toolsOf('linux', { DISPLAY: ':0' }), x11);
assert.deepEqual(toolsOf('linux', {}), []);
assert.deepEqual(toolsOf('linux', { WAYLAND_DISPLAY: '' }), []);
assert.deepEqual(toolsOf('win32', { DISPLAY: ':0' }), []);
ok(
  'the tools of a session: pbcopy on macOS, wl-copy then the X11 tools on Linux, none without a display'
);

const copiedStatus = 'copied the last answer (12 chars)';
const notice = (result) => clipboard.clipboardNotice(result, copiedStatus);
assert.equal(notice({ kind: 'copied', tool: 'pbcopy' }), copiedStatus);
const terminal = notice({ kind: 'terminal' });
assert.match(terminal, /sent to the terminal \(OSC 52\)/);
assert.doesNotMatch(terminal, /copied/i);
const failed = notice({ kind: 'failed', tool: 'xclip', reason: 'exit 1' });
assert.match(failed, /xclip failed \(exit 1\)/);
assert.match(failed, /terminal \(OSC 52\)/);
copy.setTuiLocale(true);
assert.match(notice({ kind: 'terminal' }), /已交给终端（OSC 52）；本会话没有剪贴板工具/);
assert.match(notice({ kind: 'failed', tool: 'xclip', reason: 'exit 1' }), /xclip 失败（exit 1）/);
copy.setTuiLocale(false);
ok('the status line says copied only for a tool that exited 0, else what happened');

// The real spawn, against stand-in tools found first on PATH. Each stand-in
// keeps what it was given, then exits as its name says.
if (process.platform === 'win32') {
  const result = await clipboard.writeSystemClipboard('x', { platform: 'win32', env: {} });
  assert.deepEqual(result, { kind: 'terminal' });
  ok('a session without a clipboard tool reports the terminal route and runs nothing');
} else {
  const originalPath = process.env.PATH;
  const withTools = (spec) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-clipboard-'));
    for (const [name, ending] of Object.entries(spec)) {
      const script = ending.startsWith('#!')
        ? ending
        : `#!/bin/sh\ncat > "${dir}/${name}.stdin"\n${ending}`;
      fs.writeFileSync(path.join(dir, name), `${script}\n`, { mode: 0o755 });
    }
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    return dir;
  };
  const wayland = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
  const session = (env, timeoutMs) =>
    clipboard.writeSystemClipboard('回答 answer ✓', { platform: 'linux', env, timeoutMs });

  const dir = withTools({ 'wl-copy': 'exit 3', xclip: 'exit 0', xsel: 'exit 0' });
  const copied = await session(wayland);
  assert.deepEqual(copied, { kind: 'copied', tool: 'xclip' });
  assert.equal(fs.readFileSync(path.join(dir, 'xclip.stdin'), 'utf8'), '回答 answer ✓');
  assert.ok(!fs.existsSync(path.join(dir, 'xsel.stdin')));
  ok('the first tool fails, the next one copies it whole (UTF-8), the rest never run');

  withTools({ 'wl-copy': 'exit 3', xclip: 'exit 2', xsel: 'exec sleep 30' });
  const started = Date.now();
  const timedOut = await session(wayland, 200);
  assert.deepEqual(timedOut, { kind: 'failed', tool: 'xsel', reason: 'timed out' });
  assert.ok(Date.now() - started < 3_000);
  ok('a tool that never exits is reported as timed out, and does not hang the shell');

  // A tool that cannot run: its interpreter does not exist, so the spawn
  // fails with ENOENT wherever this runs. The stand-ins stay first on PATH,
  // so a machine that has the real xclip neither copies nor is touched.
  withTools({
    xclip: '#!/nonexistent/moss-probe-interpreter',
    xsel: '#!/nonexistent/moss-probe-interpreter',
  });
  assert.deepEqual(await session({ DISPLAY: ':0' }), {
    kind: 'failed',
    tool: 'xsel',
    reason: 'not found',
  });
  assert.deepEqual(await session({}), { kind: 'terminal' });
  process.env.PATH = originalPath;
  ok('a session whose tools are not installed, or has none, is reported as such');
}

console.log(`[tui-interaction] ${String(checks)} checks passed`);
