#!/usr/bin/env node
/**
 * Markdown projection + diff gutter + detailed-transcript (ctrl+o) regression.
 *
 * Reference: `docs/cli-parity/claude-code-surface.md` §8 (diff gutter), §9
 * (collapsing / ctrl+o verbose, hidden reasoning) and §10 (markdown answers).
 *
 * The two guarantees that matter in a terminal are checked on every case:
 *   1. a rendered line is never wider than the pane (measured in CELLS — CJK is
 *      two cells, so `String.length` would overflow and re-flow the screen);
 *   2. the projection is pure data (`TuiLine[]`), so the shell cannot disagree
 *      with what these assertions read.
 */
import assert from 'node:assert/strict';

import stringWidth from 'string-width';

import {
  renderMarkdown,
  renderStreamingMarkdown,
  parseInlineMarkdown,
} from '../dist/cli/tui/markdown.js';
import {
  APPROVAL_FALLBACK_QUESTION,
  ANSWER_MARK,
  DIFF_PREVIEW_LINES,
  RESULT_MARK,
  RESULT_PREVIEW_LINES,
  hasDiffLines,
  renderApproval,
  renderDiffGutter,
  renderLive,
  renderReasoning,
  renderTranscriptRow,
  renderTranscriptRows,
} from '../dist/cli/tui/transcript.js';

const cells = (value) => stringWidth(value);
const text = (lines) => lines.map((entry) => entry.text).join('\n');

{
  const partial = renderStreamingMarkdown(
    'Intro paragraph.\n\n## Heading\n\n```ts\nconst x = 1;',
    40
  );
  assert.ok(
    text(partial).includes('Intro paragraph.'),
    'streaming projection keeps completed prose'
  );
  assert.ok(text(partial).includes('Heading'), 'heading content remains visible while streaming');
  assert.ok(text(partial).includes('```ts'), 'an open fence is not reinterpreted as prose');
  assert.ok(
    partial.every((line) => cells(line.text) <= 40),
    'streaming lines fit the pane'
  );

  const completed = renderStreamingMarkdown(
    'Intro paragraph.\n\n## Heading\n\n```ts\nconst x = 1;\n```',
    40
  );
  assert.ok(
    completed.some((line) => line.bold && line.text.includes('Heading')),
    'closed heading upgrades'
  );
  assert.ok(
    completed.some((line) => line.text.includes('┌ ts')),
    'closed fence renders as a code block'
  );
}

function assertFits(lines, width, label) {
  for (const entry of lines) {
    const value = typeof entry === 'string' ? entry : entry.text;
    assert.ok(
      cells(value) <= width,
      `${label}: line is ${cells(value)} cells wide, limit ${width}: ${JSON.stringify(value)}`
    );
  }
}

const CJK = '把相机管线部署到 RDK X5 上并测量六十秒的稳定帧率，同时记录 CPU 温度';
const CJK_CODE = 'const 问候 = "你好，moss";';

// ─── 1. markdown: inline spans ────────────────────────────────────────────

{
  assert.deepEqual(
    parseInlineMarkdown('a **b** c'),
    [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }],
    'bold markers are removed and the span is flagged'
  );
  assert.deepEqual(
    parseInlineMarkdown('*i*'),
    [{ text: 'i', italic: true }],
    'italic markers are removed'
  );
  assert.deepEqual(
    parseInlineMarkdown('`code`'),
    [{ text: 'code', code: true }],
    'inline code markers are removed'
  );
  assert.equal(
    parseInlineMarkdown('read_file and write_file').length,
    1,
    'snake_case is not emphasis (tool names would be mangled)'
  );

  // D-12: emphasis and inline code are styled PER RUN. The reference styles
  // spans, and a terminal row can carry several styles at once (nested <Text>);
  // the row-level fields are only a fallback and are set when EVERY run shares
  // the attribute, so a mixed line is never painted whole.
  const bold = renderMarkdown('**bold** and *italic* here', 40);
  assert.equal(bold.length, 1, 'a short paragraph stays on one row');
  assert.equal(bold[0].text, 'bold and italic here', 'markers never reach the screen');
  assert.deepEqual(
    bold[0].runs,
    [
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: ' here' },
    ],
    'bold and italic coexist on one line as separate runs'
  );
  assert.equal(bold[0].bold, undefined, 'a mixed line is not painted bold as a whole');

  const italic = renderMarkdown('*italic* only', 40);
  assert.equal(italic[0].text, 'italic only', 'italic markers are stripped');
  assert.deepEqual(italic[0].runs, [{ text: 'italic', italic: true }, { text: ' only' }]);
  assert.equal(italic[0].bold, undefined, 'italic-only rows are not bold');

  const code = renderMarkdown('`npm run build`', 40);
  assert.equal(code[0].text, 'npm run build', 'inline code loses its backticks');
  assert.equal(code[0].color, 'cyan', 'a pure inline-code row gets the code colour');
  assert.deepEqual(code[0].runs, [{ text: 'npm run build', color: 'cyan' }]);

  const mixed = renderMarkdown('run `npm run build` now', 40);
  assert.equal(mixed[0].text, 'run npm run build now', 'inline code inside prose is flattened');
  assert.equal(mixed[0].color, undefined, 'prose is not painted as code');
  assert.deepEqual(
    mixed[0].runs,
    [{ text: 'run ' }, { text: 'npm run build', color: 'cyan' }, { text: ' now' }],
    'inline code keeps its colour inside mixed prose (D-12)'
  );

  // Invariant for every consumer that ignores runs: the flat text is exactly
  // what the runs concatenate to.
  for (const value of [
    'use `x` now',
    '**b** and *i*',
    '`c`',
    '# 标题 **粗**',
    '- a `b` c',
    '> q `r` **s**',
  ]) {
    for (const width of [4, 5, 6, 20, 40]) {
      for (const entry of renderMarkdown(value, width)) {
        if (!entry.runs) continue;
        assert.equal(
          entry.runs.map((run) => run.text).join(''),
          entry.text,
          `runs concatenate to the flat text: ${JSON.stringify(entry.text)}@${width}`
        );
      }
    }
  }
}

// ─── 2. markdown: headings, lists, quotes, rules ──────────────────────────

{
  const heading = renderMarkdown('## 结果是 31.5 fps', 40);
  assert.equal(heading[0].text, '结果是 31.5 fps', 'heading markers are removed');
  assert.equal(heading[0].bold, true, 'headings are bold');

  const nested = renderMarkdown('- one\n- two\n  1. nested\n    - deep', 40);
  assert.deepEqual(
    nested.map((entry) => entry.text),
    ['- one', '- two', '  1. nested', '    - deep'],
    'bullet and ordered markers are preserved, nesting indents by two cells'
  );

  const wrappedBullet = renderMarkdown(`- ${'word '.repeat(30)}`, 20);
  assert.ok(wrappedBullet.length > 1, 'a long bullet wraps');
  assertFits(wrappedBullet, 20, 'bullet wrap');
  for (const entry of wrappedBullet.slice(1)) {
    assert.ok(
      entry.text.startsWith('  '),
      `bullet continuation aligns under its text: ${JSON.stringify(entry.text)}`
    );
  }

  const quote = renderMarkdown('> deploy failed', 40);
  assert.equal(quote[0].text, '│ deploy failed', 'blockquote gets a quiet bar');
  assert.equal(quote[0].dim, true, 'blockquote is dim');

  const rule = renderMarkdown('above\n\n---\n\nbelow', 12);
  assert.ok(
    rule.some((entry) => entry.text === '─'.repeat(12)),
    'a horizontal rule becomes a full-width rule'
  );
}

// ─── 3. markdown: fenced code (never re-wrapped, degrades when unterminated) ─

{
  const block = renderMarkdown('```ts\nconst a = 1;\n```', 20);
  assert.equal(block.length, 3, 'frame + one code line + frame');
  assert.ok(block[0].text.includes('ts'), 'the frame carries the language tag');
  assert.equal(block[0].dim, true, 'the frame is dim');
  assert.equal(block[1].text, '│ const a = 1;', 'the code body is indented, not re-flowed');
  assert.ok(block[2].text.startsWith('└'), 'the block is closed');
  assertFits(block, 20, 'code fence');

  const long = `\`\`\`\n${'x'.repeat(100)}\n\`\`\``;
  const clipped = renderMarkdown(long, 20);
  assert.equal(clipped.length, 3, 'an over-wide code line is clipped, never folded');
  assert.equal(cells(clipped[1].text), 20, 'the clipped code line is exactly the pane width');
  assert.ok(clipped[1].text.endsWith('…'), 'clipping is visible');

  const unterminated = renderMarkdown('intro\n```js\nlet x = 1;\nlet y = 2;', 30);
  assert.deepEqual(
    unterminated.map((entry) => entry.text),
    ['intro', `┌ js ${'─'.repeat(25)}`, '│ let x = 1;', '│ let y = 2;', `└${'─'.repeat(29)}`],
    'an unterminated fence still closes its frame and keeps the code readable'
  );
  assertFits(unterminated, 30, 'unterminated fence');
}

// ─── 4. markdown: table + CJK / width exactness ───────────────────────────

{
  const table = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |', 30);
  assert.equal(table[0].text, '┌───┬───┐', 'a real box-drawing table opens');
  assert.equal(table[1].text, '│ a │ b │', 'the header sits inside the box');
  assert.equal(table[table.length - 1].text, '└───┴───┘', 'the table closes');
  assertFits(table, 30, 'table');

  const document = [
    '# 部署报告',
    '',
    `**结论**：${CJK}，${CJK}。`,
    '',
    '- 第一项：把相机管线部署到 RDK X5',
    '- 第二项：*稳定* 运行六十秒',
    '',
    '```ts',
    CJK_CODE,
    '```',
    '',
    `> ${CJK}`,
  ].join('\n');
  for (const width of [24, 40, 80, 120]) {
    const lines = renderMarkdown(document, width);
    assert.ok(lines.length > 0, `markdown@${width} renders`);
    assertFits(lines, width, `markdown doc@${width}`);
  }

  // A space-free CJK run has no wrap point: it must be hard-split by cells.
  const noSpaces = renderMarkdown('把相机管线部署到X5并测量帧率'.repeat(3), 20, { indent: 4 });
  assertFits(noSpaces, 20, 'indented CJK markdown');
  assert.ok(
    noSpaces.every((entry) => entry.text.startsWith('    ')),
    'the indent option shifts every line'
  );

  assert.deepEqual(renderMarkdown('', 40), [], 'empty text projects to no lines');
}

// ─── 4b. degenerate panes (4–6 cells) never overflow ──────────────────────
// The contract is "no emitted line exceeds the pane" for EVERY width. `wrap()`
// in text.ts keeps a 4-cell floor, so a small budget (`width - prefix`) came
// back too wide and `+ `/`│ ` rows overflowed at 4–5 cells — the D-3 class the
// verifier's width audit caught for renderMarkdown.

{
  const document = [
    '# 标题',
    '',
    '中文宽度测试：这是一个很长的中文字符串，没有任何空格',
    'emoji ❤️ ⚠️ ✨️ 1️⃣ 👨‍👩‍👧‍👦 🇨🇳',
    '',
    '```ts',
    'const 问候 = "你好，moss";',
    '```',
    '',
    '| 项目 | 说明 |',
    '| --- | --- |',
    '| moss | 跨平台 coding agent harness |',
    '',
    '- 列表项：中文内容与 english tail',
    '',
    '> 引用一段很长的中文内容 with an english tail',
  ].join('\n');

  for (const width of [4, 5, 6]) {
    assertFits(renderMarkdown(document, width), width, `markdown@${width}`);
    assertFits(renderMarkdown(document, width, { indent: 4 }), width, `markdown+indent@${width}`);
    assertFits(
      renderTranscriptRow({ id: 1, kind: 'assistant', text: document }, width),
      width,
      `assistant markdown@${width}`
    );
  }

  // Each shape alone, so a failure names the producer that overflowed.
  const shapes = {
    fence: '```ts\nconst 问候 = "你好，moss";\n```',
    table: '| 项目 | 说明 |\n| --- | --- |\n| moss | 跨平台 coding agent harness |',
    cjk: '中文宽度测试：这是一个很长的中文字符串',
    vs16: '❤️ ⚠️ ✨️ 1️⃣ 👨‍👩‍👧‍👦 🇨🇳',
    bullet: '+ 这是一行新增的中文内容 with a long tail that keeps going and going',
    quote: '> 引用一段很长的中文内容 with an english tail',
    heading: '## 一个很长的中文标题 with an english tail',
  };
  for (const [name, shape] of Object.entries(shapes)) {
    for (const width of [4, 5, 6]) {
      const lines = renderMarkdown(shape, width);
      assert.ok(lines.length > 0, `${name}@${width} renders`);
      assertFits(lines, width, `${name}@${width}`);
    }
  }

  // A VS16 cluster is drawn as one unit and survives intact when it fits.
  assert.equal(renderMarkdown('❤️', 4)[0].text, '❤️', 'a VS16 cluster is not split');
  assert.ok(
    renderMarkdown('❤️❤️❤️', 5).every((entry) => cells(entry.text) <= 5),
    'emoji clusters wrap by cells, never by code point'
  );
}

// ─── 5. diff gutter: numbers, colours, alignment ──────────────────────────

{
  const hunk = ' ctx\n- old value\n+ new value\n+ second value';
  assert.equal(hasDiffLines(hunk), true, 'diff lines are detected');
  assert.equal(hasDiffLines('a\nb\nc'), false, 'plain output is not a diff');
  // D-11: a LONE sign line is ordinary output (`! printf '+x\n'`); a diff needs
  // a hunk header, a `---`/`+++` pair, or a run of at least two sign lines.
  assert.equal(hasDiffLines('+added without space'), false, 'a lone + line is not a diff');
  assert.equal(hasDiffLines('-just a log line'), false, 'a lone - line is not a diff');
  assert.equal(hasDiffLines('+ a\n+ b'), true, 'a run of sign lines is a diff');
  assert.equal(hasDiffLines('@@ -1 +1 @@\n-a\n+b'), true, 'a hunk header is a diff');
  assert.equal(
    hasDiffLines('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b'),
    true,
    'a file-header pair is a diff'
  );

  const lines = renderDiffGutter(hunk, 40);
  assertFits(lines, 40, 'diff gutter');
  const withMark = lines[0].text;
  assert.ok(withMark.startsWith('  ⎿  '), 'the diff block keeps the ⎿ grammar mark');
  assert.equal(lines[1].color, 'red', 'removed rows are red');
  assert.equal(lines[2].color, 'green', 'added rows are green');
  assert.equal(lines[3].color, 'green', 'every added row is green');
  assert.equal(lines[0].color, undefined, 'context rows keep the default colour');
  assert.equal(lines[0].dim, true, 'context rows stay dim');

  // D-11: without a `@@` anchor the counters would be invented, so the gutter
  // stays blank — no number is ever fabricated for content we did not anchor.
  assert.ok(
    lines.every((entry) => !/\d/.test(entry.text)),
    `an unanchored diff shows no invented numbers: ${JSON.stringify(lines.map((l) => l.text))}`
  );
  // …but the marker column is still aligned on every row.
  assert.equal(lines[1].text.indexOf('-'), 8, 'the removed marker sits after the blank gutter');
  assert.equal(lines[2].text.indexOf('+'), 8, 'the added marker sits after the blank gutter');
  assert.equal(lines[3].text.indexOf('+'), 8, 'every added row aligns');

  const codeDiff = renderDiffGutter(
    '+++ b/cam.cpp\n@@ -1 +1 @@\n-int old;\n+const int next = 1; // hi',
    80
  );
  const addedCode = codeDiff.find((entry) => entry.text.includes('const'));
  assert.ok(addedCode, 'the added source row is rendered');
  assert.equal(addedCode.color, 'green', 'the added row stays green');
  assert.ok(
    addedCode.runs?.some((run) => run.text === 'const' && run.color === 'magenta'),
    'a keyword inside the diff is coloured'
  );
  assert.ok(
    addedCode.runs?.some((run) => run.text.includes('// hi') && run.color === 'gray'),
    'a comment inside the diff is coloured'
  );
  assert.equal(
    addedCode.runs?.map((run) => run.text).join(''),
    addedCode.text,
    'syntax runs reconstruct the row'
  );
  assert.equal(lines[0].text.slice(9), 'ctx', 'context content follows the blank sign column');

  // Hunk headers move the counters to the real file lines.
  const numbered = renderDiffGutter('@@ -10,3 +20,4 @@\n ctx\n- gone\n+ fresh', 40);
  assert.ok(numbered[0].text.includes('@@ -10,3 +20,4 @@'), 'the hunk header is shown');
  assert.ok(
    numbered[0].text.startsWith('  ⎿  '),
    'a hunk header opening the block still carries the ⎿ grammar mark'
  );
  assert.equal(numbered[0].color, 'cyan', 'a hunk header is quiet cyan');
  const hunkNumbers = numbered.slice(1).map((entry) => /(\d+)/.exec(entry.text)?.[1]);
  assert.deepEqual(
    hunkNumbers,
    ['20', '11', '21'],
    'the hunk header seeds both counters (context consumes an old line)'
  );
  const numberEnds = numbered.slice(1).map((entry) => {
    const digits = /(\d+)/.exec(entry.text)?.[1] ?? '';
    return (entry.text.search(/\d/) ?? 0) + digits.length - 1;
  });
  assert.equal(new Set(numberEnds).size, 1, 'the number column never shifts');
  assert.equal(numberEnds[0], 6, 'the gutter is right-aligned on the 5-cell prefix + 2 cells');

  const elision = renderDiffGutter('@@ -1 +1 @@\n  … (12 unchanged lines)\n+ tail', 40);
  assert.ok(elision[1].text.includes('⋯'), 'a collapsed context run is marked, not numbered');

  // Continuations line up under the code, not under the gutter.
  const longLine = renderDiffGutter(`+ ${'x'.repeat(120)}`, 40);
  assert.ok(longLine.length > 1, 'a long diff line wraps');
  assertFits(longLine, 40, 'long diff line');
  for (const entry of longLine.slice(1)) {
    assert.equal(
      /^[ ]+/.exec(entry.text)?.[0].length,
      10,
      'continuation indents past the gutter + marker'
    );
    assert.ok(!/\d/.test(entry.text.slice(0, 10)), 'no number leaks into the continuation');
  }
}

// ─── 6. diff gutter wired into the result row ─────────────────────────────

{
  const row = {
    id: 1,
    kind: 'result',
    text: '@@ -1,2 +1,3 @@\n export const gamma = 3;\n+export const gamma2 = 4;',
  };
  const lines = renderTranscriptRow(row, 60);
  assert.equal(lines[0].text, '', 'every block opens with a blank separator');
  assert.ok(lines[1].text.includes(RESULT_MARK), 'a diff result row renders as a gutter block');
  assert.equal(
    lines.filter((entry) => entry.color === 'green').length,
    1,
    'the added row is green'
  );
  assert.ok(lines[2].text.includes('export const gamma = 3;'), 'the context line is preserved');
  assert.ok(lines[3].text.includes('+export const gamma2 = 4;'), 'the diff body is preserved');
  assertFits(lines, 60, 'diff result row');

  // D-11 end-to-end: a single `+`-leading shell line is NOT a diff, and the
  // transcript never invents a gutter number for it.
  const plus = renderTranscriptRow({ id: 3, kind: 'result', text: '+process.env.X' }, 60);
  assert.deepEqual(
    plus.map((entry) => entry.text),
    ['', '  ⎿  +process.env.X'],
    'a `+`-leading shell line renders as plain output with no fabricated number'
  );
  const minus = renderTranscriptRow({ id: 4, kind: 'result', text: '-not a diff' }, 60);
  assert.deepEqual(
    minus.map((entry) => entry.text),
    ['', '  ⎿  -not a diff'],
    'a `-`-leading shell line renders as plain output with no fabricated number'
  );

  // A long diff is windowed in the compact view and complete when expanded.
  const big = Array.from({ length: 30 }, (_, index) => `+line ${index + 1}`).join('\n');
  const compact = renderTranscriptRow({ id: 2, kind: 'result', text: big }, 40);
  assert.equal(
    compact.filter((entry) => entry.color === 'green').length,
    DIFF_PREVIEW_LINES,
    'the compact diff window shows DIFF_PREVIEW_LINES rows'
  );
  assert.ok(text(compact).includes('ctrl+o'), 'the windowed diff points at ctrl+o');
  const expanded = renderTranscriptRow({ id: 2, kind: 'result', text: big }, 40, true);
  assert.equal(
    expanded.filter((entry) => entry.color === 'green').length,
    30,
    'the detailed diff shows every added row'
  );
  assertFits(expanded, 40, 'verbose diff block');
}

// ─── 6b. markdown is wired into the assistant row (⏺ / continuation) ──────

{
  const row = {
    id: 5,
    kind: 'assistant',
    text: '# 报告\n\n- 第一项\n- 第二项\n\n```ts\nconst a = 1;\n```',
  };
  const lines = renderTranscriptRow(row, 40);
  assertFits(lines, 40, 'assistant markdown row');
  const body = lines.filter((entry) => entry.text.trim() !== '');
  assert.ok(body[0].text.startsWith(`${ANSWER_MARK} 报告`), 'the ⏺ mark leads the marked-up block');
  assert.equal(body[0].bold, true, 'a heading stays bold through the row prefix');
  assert.equal(body[0].text.includes('#'), false, 'no markdown marker leaks into the transcript');
  assert.ok(
    body.some((entry) => entry.text === '  - 第一项'),
    'continuation lines keep the 2-space column'
  );
  assert.ok(
    body.some((entry) => entry.text.startsWith('  ┌ ts ')),
    'a code frame is indented with the block'
  );
}

// ─── 7. verbose (ctrl+o): full output + reasoning ─────────────────────────

{
  const long = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join('\n');
  const compact = renderTranscriptRow({ id: 1, kind: 'result', text: long }, 40);
  const compactBody = compact.filter((entry) => entry.text.trim() !== '');
  assert.equal(
    compactBody.length,
    RESULT_PREVIEW_LINES + 1,
    'the compact result is a 3-line preview plus the expand marker'
  );
  assert.ok(
    compactBody[compactBody.length - 1].text.includes('ctrl+o'),
    'the marker names the key that reveals the rest'
  );
  assert.ok(compactBody[compactBody.length - 1].text.includes('3 more lines'), 'it says how many');

  const verbose = renderTranscriptRow({ id: 1, kind: 'result', text: long }, 40, true);
  const verboseBody = verbose.filter((entry) => entry.text.trim() !== '');
  assert.equal(verboseBody.length, 6, 'verbose shows every tool-output line');
  assert.ok(
    verboseBody.some((entry) => entry.text.includes('line 6')),
    'the tail is present'
  );
  assert.ok(!verboseBody.some((entry) => entry.text.includes('ctrl+o')), 'no marker when expanded');
  assertFits(verbose, 40, 'verbose result');

  assert.equal(
    renderTranscriptRows([{ id: 1, kind: 'result', text: long }], 40, true).length,
    verbose.length,
    'renderTranscriptRows forwards the verbose flag'
  );

  // Reasoning is compact-hidden and verbose-visible, for committed rows…
  const answer = { id: 2, kind: 'assistant', text: 'done', reasoning: `because ${CJK}` };
  const compactAnswer = renderTranscriptRow(answer, 60).map((entry) => entry.text);
  const verboseAnswer = renderTranscriptRow(answer, 60, true).map((entry) => entry.text);
  assert.ok(
    compactAnswer.every((line) => !line.startsWith('·')),
    'the compact answer hides the reasoning'
  );
  assert.ok(
    verboseAnswer.some((line) => line.startsWith('·')),
    'the detailed transcript shows the reasoning'
  );
  assert.ok(
    verboseAnswer.some((line) => line.startsWith(`${ANSWER_MARK} done`)),
    'verbose keeps the ⏺ grammar'
  );
  assertFits(renderTranscriptRow(answer, 60, true), 60, 'verbose reasoning');

  // …and for the live region.
  const words = (prefix, count) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
  const view = {
    running: true,
    startedAt: Date.now(),
    streaming: words('stream', 200),
    thinking: words('think', 40),
    tokensOut: 0,
    queued: 0,
  };
  const liveCompact = renderLive(view, 40);
  const liveVerbose = renderLive(view, 40, true);
  const dots = (lines) => lines.filter((entry) => entry.text.startsWith('· ')).length;
  assert.ok(dots(liveCompact) <= 2, 'the compact live region keeps the last reasoning lines');
  assert.ok(dots(liveVerbose) > dots(liveCompact), 'verbose shows more reasoning');
  assert.ok(
    liveVerbose.length > liveCompact.length,
    'verbose shows more streaming lines than the compact tail'
  );
  assertFits(liveVerbose, 40, 'verbose live');

  const reasoning = renderReasoning(`why ${CJK}`, 30);
  assert.ok(reasoning[0].text.startsWith('· '), 'reasoning lines carry the · mark');
  assert.equal(reasoning[0].dim, true, 'reasoning is quiet');
  assert.deepEqual(renderReasoning('   ', 30), [], 'blank reasoning emits nothing');
}

// ─── 8. approval: the host owns the question wording ─────────────────────

{
  const view = {
    question: 'Do you want to create beta.txt?',
    title: 'Create file',
    subject: 'beta.txt',
    preview: ['+ hi'],
    cursor: 0,
  };
  const lines = renderApproval(view, 60);
  const body = text(lines);
  assert.ok(body.includes('Do you want to create beta.txt?'), 'the host question is rendered');
  assert.ok(!body.includes(APPROVAL_FALLBACK_QUESTION), 'the hardcoded string is gone');
  assert.ok(
    body.indexOf('Create file') < body.indexOf('Do you want to create beta.txt?'),
    'title still precedes the question'
  );
  assert.ok(
    body.indexOf('Do you want to create beta.txt?') < body.indexOf('1. Yes'),
    'the question still precedes the options'
  );
  assert.ok(body.includes('Esc to deny · ↑↓ then Enter'), 'the footer stays honest');

  const multiline = renderApproval(
    { ...view, question: 'moss wants to write a file\nsrc/index.ts' },
    60
  );
  assert.ok(text(multiline).includes('moss wants to write a file'), 'only the first question line');
  assert.ok(!text(multiline).includes('src/index.ts'), 'the rest of the blob is not dumped');
  assertFits(multiline, 60, 'multiline approval');

  const blank = renderApproval({ ...view, question: '   ' }, 60);
  assert.ok(text(blank).includes(APPROVAL_FALLBACK_QUESTION), 'an empty question falls back');

  for (const width of [40, 80, 120]) {
    assertFits(renderApproval(view, width), width, `approval@${width}`);
  }
}

{
  // /permissions bakes REPL SGR into the line. The shell must drop it and
  // paint the label gray with the value in the normal colour.
  const lines = renderTranscriptRow(
    {
      id: 1,
      kind: 'detail',
      text: '  \x1b[2mdefault mode:\x1b[22m full',
    },
    80
  );
  const row = lines.find((entry) => entry.text.includes('default mode'));
  assert.ok(row, 'the permissions field is rendered');
  assert.equal(row.text.includes('\x1b'), false, 'baked-in SGR is not drawn');
  assert.ok(
    row.runs?.some((run) => run.color === 'gray' && run.text.includes('default mode')),
    'the label stays gray'
  );
  assert.ok(
    row.runs?.some((run) => run.text === 'full' && run.color === undefined),
    'the value is not washed gray'
  );
  const heading = renderTranscriptRow(
    { id: 2, kind: 'detail', text: '\x1b[1m\x1b[30mPermissions\x1b[39m\x1b[22m' },
    80
  ).find((entry) => entry.text.includes('Permissions'));
  assert.ok(heading, 'the heading survives SGR stripping');
  assert.equal(heading.bold, true);
  assert.equal(heading.color, 'cyan');
  assert.equal(heading.text.includes('\x1b'), false);
}

console.log('OK tui-markdown');
