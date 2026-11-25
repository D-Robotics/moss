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
  ]) {
    const value = copy.ZH[key];
    assert.ok(value && value.length > 0, `${key} has a zh string`);
    assert.notEqual(value, key, `${key} translates to something else`);
  }
} finally {
  copy.setTuiLocale(false);
}
ok('the queue chrome and the catalog row read in Chinese too');

console.log(`[tui-interaction] ${String(checks)} checks passed`);
