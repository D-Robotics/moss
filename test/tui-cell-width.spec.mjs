#!/usr/bin/env node
/**
 * CLI shell cell-width regression: every projection must be measured in terminal
 * CELLS, not UTF-16 code units. A CJK goal (2 cells per glyph) measured with
 * `String.length` comes out half its real width, overflows its line, and makes
 * the terminal hard-wrap and re-flow the whole screen.
 *
 * Retargeted from the deleted Mission Control panels to the v0.22 single-column
 * grammar: text.ts primitives + transcript.ts projections (rows, banner, live
 * region, approval, composer, status/hint chrome).
 */
import assert from 'node:assert/strict';

import stringWidth from 'string-width';

import { clip, displayWidth, line, padStartTo, rule, wrap } from '../dist/cli/tui/text.js';
import { renderMarkdown } from '../dist/cli/tui/markdown.js';
import {
  ANSWER_MARK,
  APPROVAL_OPTIONS,
  COMPOSER_MAX_ROWS,
  RESULT_MARK,
  USER_MARK,
  infoBlock,
  renderApproval,
  renderBanner,
  renderComposer,
  renderDiffGutter,
  renderHint,
  renderLive,
  renderRunSummary,
  renderStatusRight,
  renderTranscriptRow,
  renderTranscriptRows,
} from '../dist/cli/tui/transcript.js';

const CJK_GOAL =
  '把相机管线部署到 RDK X5 上并测量六十秒的稳定帧率，同时记录 CPU 温度和内存占用，最后把结果写进证据文件';
const CJK_METRIC = '稳定帧率:camera_fps';
// Space-free runs have no natural wrap point: they must be hard-split by cells.
const CJK_RUN = '把相机管线部署到X5并测量帧率';
const ASCII_BLOB = 'x'.repeat(120);

function cells(text) {
  return stringWidth(text);
}

function assertFits(lines, width, label) {
  for (const entry of lines) {
    const text = typeof entry === 'string' ? entry : entry.text;
    assert.ok(
      cells(text) <= width,
      `${label}: line is ${cells(text)} cells wide, limit ${width}: ${JSON.stringify(text)}`
    );
  }
}

// ─── 1. primitives measure cells, not code units ──────────────────────────

{
  assert.equal(displayWidth('相机'), 4, 'CJK glyphs are 2 cells');
  assert.equal(cells('相机'), 4, 'string-width agrees with displayWidth');
  assert.equal(clip('相机管线部署', 5), '相机…', 'clip counts cells');
  assert.equal(clip('中文中', 2), '…', 'width 2 fits no glyph before the ellipsis');
  assert.equal(clip('tty', 10), 'tty', 'text that fits is untouched');

  const wrapped = wrap(CJK_GOAL, 24);
  assert.ok(wrapped.length > 1, 'CJK prose wraps');
  assertFits(wrapped, 24, 'wrap(cjk)');
  assert.equal(wrapped.join('').replace(/\s/g, ''), CJK_GOAL.replace(/\s/g, ''), 'no text is lost');

  const hardSplit = wrap(ASCII_BLOB, 20);
  assertFits(hardSplit, 20, 'wrap(ascii blob)');
  assert.equal(hardSplit.join(''), ASCII_BLOB, 'hard split keeps every character');
  const cjkSplit = wrap(CJK_RUN, 20);
  assert.ok(cjkSplit.length > 1, 'space-free CJK is hard-split');
  assertFits(cjkSplit, 20, 'wrap(cjk run)');

  assert.equal(padStartTo('ab', 5), '   ab', 'padStartTo pads by cells');
  assert.equal(padStartTo('相机', 6), '  相机', 'padStartTo counts CJK as 2 cells');
  assert.equal(padStartTo('abcdef', 3), 'abcdef', 'never truncates to a negative pad');

  assert.equal(rule(7), '───────', 'rule is exactly the requested width');
  assert.equal(cells(rule(40)), 40, 'rule width in cells');
  assert.equal(cells(rule(0)), 1, 'rule keeps one cell at width 0');
  assert.equal(line('x', { bold: true, color: 'cyan' }).text, 'x', 'line keeps the text');
  assert.equal(line('x', { bold: true }).bold, true, 'line keeps its style');
}

// ─── 2. transcript rows never exceed the pane width ───────────────────────

{
  const rows = [
    { id: 1, kind: 'user', text: CJK_GOAL },
    { id: 2, kind: 'assistant', text: CJK_GOAL },
    { id: 3, kind: 'tool', text: `Device Exec(${CJK_GOAL})` },
    { id: 4, kind: 'result', text: `${CJK_GOAL}\n${CJK_METRIC}\n${ASCII_BLOB}` },
    { id: 5, kind: 'detail', text: `    ${CJK_GOAL}` },
    { id: 6, kind: 'system', text: CJK_RUN },
    { id: 7, kind: 'error', text: `部署失败：${CJK_GOAL}` },
    { id: 8, kind: 'banner', text: `moss v0.22.0\n${CJK_GOAL}\n${CJK_RUN}` },
  ];
  for (const width of [40, 80, 120]) {
    const lines = renderTranscriptRows(rows, width);
    assertFits(lines, width, `transcript rows@${width}`);
  }

  const userLines = renderTranscriptRow(rows[0], 40).map((l) => l.text);
  const [userMark, ...userBody] = userLines.filter((text) => text !== '');
  assert.ok(userMark.startsWith(`${USER_MARK} `), 'user row carries the ❯ mark');
  assert.equal(
    [userMark.slice(2), ...userBody].join('').replace(/\s/g, ''),
    CJK_GOAL.replace(/\s/g, ''),
    'a wrapped CJK goal survives the row projection intact'
  );

  const assistant = renderTranscriptRow(rows[1], 40)
    .map((l) => l.text)
    .filter((text) => text !== '');
  assert.ok(assistant[0].startsWith(`${ANSWER_MARK} `), 'assistant row carries the ⏺ mark');

  const result = renderTranscriptRow(rows[3], 40).map((l) => l.text);
  assert.ok(result[1].includes(RESULT_MARK), 'result row carries the ⎿ mark');
  const preview = renderTranscriptRow({ id: 9, kind: 'result', text: 'a\nb\nc' }, 200).map(
    (l) => l.text
  );
  assert.deepEqual(
    preview,
    ['', '  ⎿  a', '     b', '     c'],
    'result rows align continuation lines under the ⎿ mark'
  );

  // The same row rendered wider must not gain or lose content.
  const wideUser = renderTranscriptRow(rows[0], 120)
    .map((l) => l.text)
    .filter((text) => text !== '');
  assert.equal(wideUser.length, 1, 'a 120-cell pane keeps the goal on one row');
  assert.ok(wideUser[0].includes(CJK_GOAL), 'wide row shows the goal verbatim');
}

// ─── 3. composer: long input wraps, shows its tail and its cursor ─────────

{
  const placeholder = renderComposer('', 40, true);
  assert.equal(placeholder.length, 1, 'placeholder is one row');
  assert.ok(placeholder[0].text.startsWith(USER_MARK), 'placeholder sits under the ❯ mark');
  assert.ok(placeholder[0].text.includes('Try "'), 'placeholder teaches the goal shape');
  assertFits(placeholder, 40, 'placeholder');

  const short = renderComposer('测量帧率', 40, false);
  assert.equal(short.length, 1, 'short input stays on one row');
  assert.ok(short[0].text.endsWith('▌'), 'cursor visible');
  assert.ok(short[0].text.startsWith(USER_MARK), 'composer echoes the ❯ mark');

  const long = renderComposer(CJK_GOAL, 40, false);
  assert.ok(long.length > 1, 'long input wraps');
  assert.ok(long.length <= COMPOSER_MAX_ROWS, 'composer window is bounded');
  assert.ok(long[long.length - 1].text.endsWith('▌'), 'cursor stays visible at the tail');
  assertFits(long, 40, 'composer');

  // Input taller than the window: the head is elided and marked, the tail (and
  // therefore the cursor) survives.
  const overflow = renderComposer(ASCII_BLOB.repeat(3), 40, false);
  assert.equal(overflow.length, COMPOSER_MAX_ROWS, 'composer window is exactly its bound');
  assert.ok(overflow[0].text.startsWith('…'), 'elided head is marked');
  assert.ok(overflow[overflow.length - 1].text.endsWith('▌'), 'overflow keeps the cursor');
  assertFits(overflow, 40, 'composer(overflow)');
}

// ─── 4. approval prompt stays inside the pane ─────────────────────────────

{
  const view = {
    question: `允许写入？${CJK_GOAL}`,
    title: `Write a file ${CJK_RUN}`,
    subject: `/userdata/${CJK_RUN}`,
    preview: [CJK_GOAL, ASCII_BLOB],
    cursor: 0,
  };
  for (const width of [40, 80, 120]) {
    const lines = renderApproval(view, width);
    assertFits(lines, width, `approval@${width}`);
    assert.equal(cells(lines[0].text), width, 'approval opens with a full-width rule');
  }

  const options = renderApproval({ ...view, preview: undefined }, 80)
    .map((l) => l.text)
    .filter((text) => /[123]\. /.test(text));
  assert.equal(options.length, APPROVAL_OPTIONS.length, 'all three options are numbered');
  assert.ok(options[0].includes('❯ 1. Yes'), 'the cursor marks the first option');
  const moved = renderApproval({ ...view, preview: undefined, cursor: 2 }, 80)
    .map((l) => l.text)
    .filter((text) => /[123]\. /.test(text));
  assert.ok(moved[2].includes('❯ 3. No'), 'the cursor follows the view');
}

// ─── 5. banner / live / summary / info block / chrome all fit ─────────────

{
  for (const width of [40, 80, 120]) {
    assertFits(
      renderBanner({ version: '0.22.0', model: CJK_RUN, device: CJK_RUN, cwd: CJK_RUN }, width),
      width,
      `banner@${width}`
    );
    assertFits(
      renderLive(
        {
          running: true,
          startedAt: Date.now() - 12_345,
          toolLine: `Device Exec(${CJK_RUN})`,
          streaming: CJK_GOAL,
          thinking: CJK_GOAL,
          tokensOut: 123_456,
          queued: 3,
        },
        width
      ),
      width,
      `live@${width}`
    );
    assertFits(renderRunSummary(5000, true, width), width, `summary@${width}`);
    assertFits(infoBlock(CJK_METRIC, [CJK_GOAL, ASCII_BLOB], width), width, `infoBlock@${width}`);
    assertFits(
      [
        renderStatusRight(
          { running: true, model: CJK_RUN, tokens: 123_456, taskCount: 2, queueLength: 1 },
          width
        ),
      ],
      width,
      `statusRight@${width}`
    );
    assertFits(
      [renderHint({ running: true, tokens: 1, taskCount: 3, queueLength: 2 }, width)],
      width,
      `hint@${width}`
    );
  }

  // The status line is right-aligned inside the pane, not clipped short of it.
  const status = renderStatusRight(
    { running: true, model: 'deepseek-flash', tokens: 1500, taskCount: 0, queueLength: 0 },
    60
  );
  assert.equal(cells(status.text), 60, 'status right occupies the full pane width');
  assert.ok(status.text.endsWith('deepseek-flash · 1.5k out'), 'status content is flush right');

  // Bottom chrome contract: full-width rules bracket the composer, and the
  // hint is the last line — the composer can never float mid-pane.
  const width = 40;
  const chrome = [
    renderStatusRight({ running: false, tokens: 0, taskCount: 0, queueLength: 0 }, width),
    line(rule(width)),
    ...renderComposer('hi', width, false),
    line(rule(width)),
    renderHint({ running: false, tokens: 0, taskCount: 0, queueLength: 0 }, width),
  ];
  assert.equal(cells(chrome[1].text), width, 'rule above the composer is full width');
  assert.equal(
    cells(chrome[chrome.length - 2].text),
    width,
    'rule below the composer is full width'
  );
  assert.ok(
    chrome[chrome.length - 1].text.includes('? for shortcuts'),
    'the hint is the final chrome row'
  );
  assertFits(chrome, width, 'chrome');
}

// ─── 6. markdown / diff gutter / verbose stay inside the pane ─────────────

{
  const markdown = [
    '# 部署报告',
    '',
    `**结论**：${CJK_GOAL}`,
    '',
    '- 第一项：把相机管线部署到 RDK X5',
    '- 第二项：*稳定* 运行六十秒',
    '',
    '```ts',
    `const 问候 = "${CJK_RUN}";`,
    '```',
    '',
    `> ${CJK_GOAL}`,
  ].join('\n');
  const diff = ['@@ -1,3 +1,4 @@', ` ${CJK_GOAL}`, `- ${CJK_GOAL}`, `+ ${CJK_GOAL}`].join('\n');
  const long = Array.from({ length: 8 }, (_, index) => `输出 ${index + 1}：${CJK_GOAL}`).join('\n');
  for (const width of [40, 80, 120]) {
    assertFits(renderMarkdown(markdown, width), width, `markdown@${width}`);
    assertFits(renderDiffGutter(diff, width), width, `diff@${width}`);
    assertFits(
      renderTranscriptRow({ id: 1, kind: 'assistant', text: markdown }, width),
      width,
      `assistant markdown@${width}`
    );
    assertFits(
      renderTranscriptRow({ id: 2, kind: 'result', text: long }, width),
      width,
      `compact result@${width}`
    );
    assertFits(
      renderTranscriptRow({ id: 2, kind: 'result', text: long }, width, true),
      width,
      `verbose result@${width}`
    );
  }

  // A CJK diff row is measured in cells, so the gutter never overflows.
  const gutter = renderDiffGutter(`+ ${CJK_RUN}`, 24);
  assertFits(gutter, 24, 'cjk diff');
  assert.ok(gutter.length >= 1, 'a CJK diff line still renders');
}

console.log('OK tui-cell-width');
