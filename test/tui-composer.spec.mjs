#!/usr/bin/env node
/**
 * Composer editor: the input line is an editor, not an append-only buffer.
 * Covers caret movement/insertion/deletion, multi-line drafts, soft wrapping in
 * terminal CELLS (CJK/emoji), the caret window, and the caret cell itself.
 */
import assert from 'node:assert/strict';

import stringWidth from 'string-width';

import {
  COMPOSER_MAX_ROWS,
  caretAt,
  composerDelete,
  composerInsert,
  composerMove,
  composerRows,
  composerSetValue,
  createComposer,
  renderComposerEditor,
  wrapSpans,
} from '../dist/cli/tui/composer.js';
import { renderComposer } from '../dist/cli/tui/transcript.js';
import { clip } from '../dist/cli/tui/text.js';

const flat = (view) => view.lines.map((runs) => runs.map((run) => run.text).join(''));
const CJK = '把相机管线部署到 RDK X5 上并测量六十秒的稳定帧率，同时记录 CPU 温度';

function assertFits(view, width, label) {
  for (const text of flat(view)) {
    assert.ok(
      stringWidth(text) <= width,
      `${label}: ${stringWidth(text)} cells > ${width}: "${text}"`
    );
  }
}

// ─── 1. insertion happens at the caret, not at the end ────────────────────

{
  let state = createComposer('hello world');
  for (let i = 0; i < 5; i += 1) state = composerMove(state, 'left');
  state = composerInsert(state, 'X');
  assert.equal(state.value, 'hello Xworld', 'insert lands at the caret');
  assert.equal(state.caret, 7, 'caret follows the inserted text');

  state = composerInsert(state, 'ABC');
  assert.equal(state.value, 'hello XABCworld', 'repeated inserts chain at the caret');

  // Code-point safety: an emoji must not be split by caret movement.
  let emoji = composerSetValue('a📷b', 3);
  emoji = composerMove(emoji, 'left');
  assert.equal(emoji.caret, 1, 'left steps over the whole surrogate pair');
  emoji = composerDelete(emoji, 'backward');
  assert.equal(emoji.value, '📷b', 'backspace removes one code point');
}

// ─── 2. motions ──────────────────────────────────────────────────────────

{
  const base = createComposer('one two three');
  assert.equal(composerMove(base, 'left').caret, 12, 'left');
  assert.equal(composerMove(base, 'word-left').caret, 8, 'word-left stops at the word start');
  assert.equal(composerMove(base, 'line-start').caret, 0, 'line-start');
  assert.equal(composerMove(composerSetValue('ab', 0), 'right').caret, 1, 'right');
  assert.equal(composerMove(composerSetValue('one two', 0), 'word-right').caret, 3, 'word-right');
  assert.equal(composerSetValue('a\nbb\nccc', 99).caret, 8, 'caret clamps to the value');
  assert.equal(
    composerMove(composerSetValue('a\nbb\nccc', 0), 'line-end').caret,
    1,
    'line-end stops at the newline'
  );
}

// ─── 3. deletion units ───────────────────────────────────────────────────

{
  assert.equal(composerDelete(createComposer('abc'), 'backward').value, 'ab', 'backspace');
  assert.equal(composerDelete(composerSetValue('abc', 0), 'forward').value, 'bc', 'delete');
  assert.equal(
    composerDelete(createComposer('one two three'), 'word-backward').value,
    'one two ',
    'ctrl+w drops one word'
  );
  assert.equal(
    composerDelete(composerSetValue('one two three', 3), 'line-end').value,
    'one',
    'ctrl+k drops to the end of the line'
  );
  assert.equal(
    composerDelete(composerSetValue('one two three', 8), 'line-start').value,
    'three',
    'ctrl+u drops to the start of the line'
  );
}

// ─── 4. multi-line drafts ────────────────────────────────────────────────

{
  let state = composerInsert(createComposer('first line'), '\n');
  assert.equal(state.value, 'first line\n', 'newline inserts a real line break');
  state = composerInsert(state, 'second line');
  const view = renderComposerEditor(state, { width: 40, maxRows: COMPOSER_MAX_ROWS });
  assert.deepEqual(
    flat(view).map((row) => row.trimEnd()),
    ['first line', 'second line'],
    'two logical lines = two rows'
  );
  assert.equal(view.caretRow, 1, 'the caret is on the second row');

  const moved = composerMove(state, 'up', 40);
  assert.equal(moved.caret, 10, 'up keeps the column and lands on the line above');
}

// ─── 5. soft wrapping in cells + caret window ────────────────────────────

{
  const view = renderComposerEditor(createComposer(CJK), {
    width: 40,
    maxRows: COMPOSER_MAX_ROWS,
    firstPrefix: '❯ ',
    restPrefix: '  ',
  });
  assertFits(view, 40, 'cjk composer');
  assert.ok(flat(view).length > 1, 'a long CJK goal wraps');

  // The window follows the caret: rows above are hidden and marked.
  const long = renderComposerEditor(createComposer('x'.repeat(400)), {
    width: 40,
    maxRows: COMPOSER_MAX_ROWS,
    firstPrefix: '❯ ',
    restPrefix: '  ',
    markElision: true,
  });
  assert.equal(long.lines.length, COMPOSER_MAX_ROWS, 'the window is bounded');
  assertFits(long, 40, 'windowed composer');
  assert.equal(long.caretRow, COMPOSER_MAX_ROWS - 1, 'the caret row is always visible');

  // A caret on a soft-wrap boundary belongs to the next row (the cell exists).
  const boundary = createComposer('abcd');
  const rows = composerRows(boundary, 2);
  assert.equal(caretAt({ value: 'abcd', caret: 2 }, 2, rows).row, 1, 'boundary caret moves down');

  // Caret at the end of a full row still gets a cell of its own.
  const full = renderComposerEditor(createComposer('abcd'), {
    width: 6,
    maxRows: 4,
    firstPrefix: '❯ ',
    restPrefix: '  ',
  });
  assert.equal(flat(full)[flat(full).length - 1].trim(), '', 'the caret can sit on its own row');
}

// ─── 6. the caret cell is an inverted run at the caret column ────────────

{
  const state = composerMove(createComposer('hello'), 'left', 20);
  const edited = renderComposerEditor(state, { width: 20, maxRows: 2, firstPrefix: '❯ ' });
  const runs = edited.lines[0];
  assert.equal(
    runs.map((run) => run.text).join(''),
    '❯ hello',
    'moving the caret does not insert a cell into the text'
  );
  assert.equal(edited.caretCol, stringWidth('❯ hell'), 'the hardware cursor sits on the caret');
  assert.equal(
    runs.some((run) => run.inverse),
    false,
    'the projection does not paint a fake caret'
  );

  // Placeholder mode is a single row and carries no caret.
  const empty = renderComposerEditor(createComposer(''), {
    width: 40,
    maxRows: 3,
    placeholder: 'Try "stream the camera at 30 fps and verify it"',
    firstPrefix: '❯ ',
  });
  assert.equal(empty.placeholder, true, 'empty composer shows the placeholder');
  assert.equal(flat(empty).length, 1, 'the placeholder is one row');
  assert.ok(flat(empty)[0].startsWith('❯ Try "'), 'the placeholder carries the prompt mark');
  assert.equal(
    empty.lines[0].some((run) => run.inverse),
    false,
    'the placeholder has no caret cell'
  );
}

// ─── 7. D-3 — cell-width fuzz over CJK / VS16 / ZWJ / combining clusters ──
//
// The defect: `wrapSpans`/`caretAt`/`offsetAt`/`takeCells` summed
// `displayWidth` per CODE POINT, so the cluster `❤` + U+FE0F counted 1 cell
// while the terminal paints 2 — the composer emitted a row one cell wider than
// the terminal, which hard-wrapped and re-flowed the whole frame (B15, the
// verifier's `scratch/verify-width-audit.mjs`). A zero-width trailing cluster
// (a tab) could leave the caret on a row with no cell left, same overflow.
//
// This loop cannot come back: every emitted line of every projection, at every
// width, for random adversarial strings and random carets, is measured in cells.

const ATOMS = [
  'a',
  'Z',
  '中',
  '，',
  '❤️',
  '⚠️',
  '✨️',
  '📷',
  '🚀',
  '👨‍👩‍👧‍👦',
  '🇨🇳',
  '1️⃣',
  'e\u0301',
  '\u200d',
  '\ufe0f',
  ' ',
  '\t',
];

/** Deterministic PRNG: a failure here must be reproducible. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0xc0ffee);
const FUZZ_STRINGS = [
  'a'.repeat(27) + '❤️',
  '❤️'.repeat(20),
  '👨‍👩‍👧‍👦'.repeat(12),
  '中'.repeat(40),
  'e\u0301'.repeat(30),
  '1️⃣'.repeat(20),
  '⚠️'.repeat(15),
  'a\t'.repeat(20),
  '\ufe0f'.repeat(8),
];
for (let index = 0; index < 400; index += 1) {
  const count = 1 + Math.floor(random() * 30);
  let value = '';
  for (let atom = 0; atom < count; atom += 1) {
    value += ATOMS[Math.floor(random() * ATOMS.length)];
  }
  FUZZ_STRINGS.push(value);
}

const FUZZ_WIDTHS = [4, 5, 6, 7, 9, 12, 20, 30, 33, 48, 80, 120];
let fuzzChecks = 0;

function assertLinesFit(lines, width, label) {
  for (const entry of lines) {
    const value = typeof entry === 'string' ? entry : entry.text;
    fuzzChecks += 1;
    assert.ok(
      stringWidth(value) <= width,
      `${label}: ${stringWidth(value)} cells > ${width} cells: ${JSON.stringify(value)}`
    );
  }
}

for (const value of FUZZ_STRINGS) {
  const carets = new Set([0, 1, value.length, Math.floor(value.length / 2)]);
  carets.add(Math.min(value.length, Math.floor(random() * (value.length + 1))));
  for (const width of FUZZ_WIDTHS) {
    const label = `fuzz ${JSON.stringify(value.slice(0, 24))} @${width}`;
    const rowWidth = Math.max(1, width - 2);

    // Soft-wrap spans never exceed one row's cell budget.
    for (const span of wrapSpans(value, rowWidth)) {
      fuzzChecks += 1;
      assert.ok(
        stringWidth(value.slice(span.start, span.end)) <= rowWidth,
        `${label}: span ${span.start}..${span.end} is ` +
          `${stringWidth(value.slice(span.start, span.end))} cells > ${rowWidth}`
      );
    }

    for (const caret of carets) {
      const state = { value, caret };
      // 1. the interactive editor (own caret cell, insertion mode)
      const editor = renderComposerEditor(state, {
        width,
        maxRows: COMPOSER_MAX_ROWS,
        firstPrefix: '❯ ',
        restPrefix: '  ',
      });
      assertFits(editor, width, `${label} caret=${caret} editor`);
      const editorTexts = editor.lines.map((runs) => runs.map((run) => run.text).join(''));
      assertLinesFit(editorTexts, width, `${label} caret=${caret} editor`);
      // 2. the plain-text projection (block caret, elision marker)
      const plain = renderComposerEditor(state, {
        width,
        maxRows: COMPOSER_MAX_ROWS,
        firstPrefix: '❯ ',
        restPrefix: '  ',
        markElision: true,
      });
      assertLinesFit(
        plain.lines.map((runs) => runs.map((run) => run.text).join('')),
        width,
        `${label} caret=${caret} plain`
      );
      // 3. the transcript projection specs and previews render
      assertLinesFit(renderComposer(value, width, false), width, `${label} caret=${caret} rows`);
      // 4. the caret sits inside the row budget — or the row is already full, in
      // which case the renderer must give the caret a row of its own (there is
      // no cell to put it in). `displayWidth` is not monotonic for pathological
      // double-VS16 clusters, so the emitted width is the hard guarantee.
      const position = caretAt(state, rowWidth);
      const caretRows = composerRows(state, rowWidth);
      fuzzChecks += 1;
      assert.ok(
        position.row >= 0 && position.row < caretRows.length,
        `${label} caret=${caret}: caret row ${position.row} is outside the frame`
      );
      const caretRowSpan = caretRows[position.row];
      const caretRowCells = stringWidth(value.slice(caretRowSpan.start, caretRowSpan.end));
      fuzzChecks += 1;
      assert.ok(
        position.column <= rowWidth || caretRowCells >= rowWidth,
        `${label} caret=${caret}: caret column ${position.column} > ${rowWidth} on a row of ` +
          `only ${caretRowCells} cells`
      );
    }
  }
}

// The verifier's exact repro: at cols=30, 27 'a' + a VS16 heart stayed inside
// the width and wrapped the cluster onto a continuation row.
{
  const value = `${'a'.repeat(27)}❤️`;
  const lines = renderComposer(value, 30, false);
  assert.ok(lines.length >= 2, 'the VS16 cluster wraps instead of overflowing');
  assertLinesFit(lines, 30, 'VS16 repro @30');
  assert.equal(stringWidth(lines[0].text), 29, 'the first row is 27 a + the 2-cell prompt');
  assert.ok(
    lines.some((entry) => entry.text.includes('❤️')),
    'the emoji survives on its continuation row'
  );
  assert.equal(
    lines
      .map((entry) => entry.text)
      .join('')
      .includes('❤\uFE0F'),
    true,
    'the variation sequence is never split'
  );
}

// The degenerate pane: a 4- or 5-cell composer used to emit a 6-cell row.
for (const width of [4, 5]) {
  assertLinesFit(renderComposer('中文测试', width, false), width, `tiny @${width}`);
  assertFits(
    renderComposerEditor(createComposer('中文测试'), {
      width,
      maxRows: COMPOSER_MAX_ROWS,
      firstPrefix: '❯ ',
      restPrefix: '  ',
    }),
    width,
    `tiny editor @${width}`
  );
  assertLinesFit(renderComposer('', width), width, `tiny placeholder @${width}`);
}

// ─── 9. N-2: clipping cuts on GRAPHEME boundaries, not code points ───────
//
// `clip()` routed through `truncateTerminalText`, which walks UTF-16 code units:
// 65 of 5804 clips kept a lone `❤` and dropped its U+FE0F, so the row stayed
// inside the width but the glyph changed shape. Whole clusters or nothing.

{
  const heart = '❤️';
  const family = '👨‍👩‍👧‍👦';
  assert.equal(
    clip(heart.repeat(12), 2),
    '…',
    'a 2-cell cluster is never split to fit 1 cell + `…`'
  );
  assert.equal(clip(heart.repeat(12), 5), `${heart}${heart}…`, 'whole clusters plus the marker');
  assert.equal(clip(family.repeat(6), 3), `${family}…`, 'a ZWJ family survives clipping whole');
  assert.equal(clip('abc', 1), '…', 'a 1-cell budget is the marker alone');
  assert.equal(clip('', 0), '', 'nothing to clip stays nothing');
  for (const value of [heart.repeat(12), family.repeat(6), `mix 中文 ${heart} text 中`]) {
    for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 12, 20]) {
      const out = clip(value, width);
      fuzzChecks += 1;
      assert.ok(
        stringWidth(out) <= width,
        `clip@${width} stays inside the budget: ${JSON.stringify(out)}`
      );
      const body = out.endsWith('…') ? out.slice(0, -1) : out;
      // Every kept cluster must be whole: heart/family are 2-cell, 2/11-unit
      // clusters, so a body of hearts has an even length and no lone base scalar.
      assert.ok(
        !body.includes('❤') || !/❤(?!\uFE0F)/.test(body),
        `no bare base scalar before the marker: ${JSON.stringify(out)}`
      );
    }
  }
}

console.log(`OK tui-composer (${fuzzChecks} fuzz cell checks)`);
