#!/usr/bin/env node
/** Viewport stays inside its window and keeps the anchor across resize. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createViewport,
  moveTranscript,
  scrollThumb,
  viewportAtRatio,
  pinViewport,
  rebaseViewport,
  scrollViewport,
  viewportWindow,
} from '../dist/cli/tui/viewport.js';

function lines(count) {
  return Array.from({ length: count }, (_, index) => ({
    rowId: index,
    lineIndex: 0,
    text: `row ${index}`,
  }));
}

{
  const all = lines(100);
  const pinned = viewportWindow(all, createViewport(), 10);
  assert.equal(pinned.lines.at(-1)?.text, 'row 99');
  assert.equal(pinned.pinned, true);
  const up = scrollViewport(pinned, all.length, -10, 10);
  const window = viewportWindow(all, up, 10);
  assert.equal(window.pinned, false);
  assert.ok(window.lines.every((line) => line.rowId >= 0 && line.rowId < 100));
  const anchor = window.lines[0];
  const resized = rebaseViewport(all, anchor, 6, false);
  const again = viewportWindow(all, resized, 6);
  assert.ok(again.lines.some((line) => line.rowId === anchor.rowId));
  const bottom = viewportWindow(all, pinViewport(), 6);
  assert.equal(bottom.lines.at(-1)?.text, 'row 99');
}

{
  const pinned = createViewport();
  const up = moveTranscript(pinned, 100, 10, 'up');
  assert.equal(up.action, 'scroll');
  if (up.action === 'scroll') {
    assert.equal(up.state.pinned, false);
    assert.ok(up.state.offsetFromBottom > 0);
    const top = moveTranscript(up.state, 100, 10, 'up');
    assert.equal(top.action, 'scroll');
  }
  assert.equal(moveTranscript(pinned, 100, 10, 'down').action, 'recall');
  assert.equal(moveTranscript(pinned, 5, 10, 'up').action, 'recall');
  const atTop = scrollViewport(pinned, 100, -100, 10);
  assert.equal(moveTranscript(atTop, 100, 10, 'up').action, 'recall');
}

{
  const all = lines(10_000);
  const start = performance.now();
  viewportWindow(all, scrollViewport(createViewport(), all.length, -20, 24), 24);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5, `scroll ${elapsed.toFixed(2)}ms`);
}

{
  // Lines appended while scrolled up (a streaming answer) must not drag the window.
  const before = lines(100);
  const scrolled = scrollViewport(createViewport(), before.length, -10, 10);
  const seen = viewportWindow(before, scrolled, 10).lines.map((line) => line.text);
  const grown = [...before, ...lines(20).map((line) => ({ ...line, rowId: line.rowId + 100 }))];
  const after = viewportWindow(grown, scrolled, 10);
  assert.deepEqual(
    after.lines.map((line) => line.text),
    seen,
    'the visible rows stay the same while the transcript grows below'
  );
  assert.equal(after.pinned, false);
  // Scrolling again continues from where the content is, not from a stale offset.
  const more = scrollViewport(scrolled, grown.length, -5, 10);
  assert.equal(
    viewportWindow(grown, more, 10).lines[0]?.text,
    seen[0] === undefined ? undefined : grown[grown.findIndex((l) => l.text === seen[0]) - 5]?.text
  );
}

// ─── P1 anchors, scrollbar geometry, pointer placement ─────────────────────

{
  // The reader is scrolled up. Content BELOW the window shrinks (a streaming
  // tail committing into a shorter row). The offset model drifts; the anchor
  // keeps the same line on top.
  const before = lines(100);
  const scrolled = scrollViewport(createViewport(), before, -10, 10);
  const topBefore = viewportWindow(before, scrolled, 10).lines[0];
  const shrunk = before.slice(0, -3);
  const anchored = viewportWindow(shrunk, scrolled, 10);
  assert.equal(anchored.lines[0].rowId, topBefore.rowId, 'the anchored line stays on top');
  const offsetOnly = { offsetFromBottom: scrolled.offsetFromBottom, pinned: false, total: 100 };
  assert.notEqual(
    viewportWindow(shrunk, offsetOnly, 10).lines[0].rowId,
    topBefore.rowId,
    'without the anchor the window moves (the regression this guards)'
  );
}

{
  // Pinned windows never carry a stale anchor into the bottom.
  const all = lines(50);
  const pinned = scrollViewport(createViewport(), all, 5, 10);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.anchor, undefined);
  assert.equal(viewportWindow(all, pinned, 10).lines.at(-1).text, 'row 49');
}

{
  // Scrollbar pointer: top of the track is the oldest rows, bottom is the newest.
  const all = lines(100);
  const top = viewportAtRatio(all, 10, 0);
  assert.equal(viewportWindow(all, top, 10).lines[0].text, 'row 0');
  const bottom = viewportAtRatio(all, 10, 9);
  assert.equal(bottom.pinned, true, 'the bottom of the track is the pinned bottom');
  const middle = viewportAtRatio(all, 10, 4);
  const mid = viewportWindow(all, middle, 10).lines[0].rowId;
  assert.ok(mid > 0 && mid < 90, `middle of the track lands mid-transcript (${mid})`);
}

{
  // Thumb: size tracks the visible fraction, position tracks the window.
  assert.equal(scrollThumb(8, 10, 0), null, 'no bar when everything fits');
  const top = scrollThumb(100, 10, 0);
  const bottom = scrollThumb(100, 10, 90);
  assert.equal(top.top, 0);
  assert.equal(bottom.top + bottom.size, 10, 'the thumb reaches the track end at the bottom');
  assert.ok(top.size >= 1 && top.size <= 10);
}

// P1 arrows: the thumb lives on the track between the two arrow rows.
{
  const top = scrollThumb(100, 10, 0, 8);
  const bottom = scrollThumb(100, 10, 90, 8);
  assert.equal(top.top, 0, 'the top of the transcript puts the thumb at the top of the track');
  assert.equal(
    bottom.top + bottom.size,
    8,
    'the bottom of the transcript puts it at the track end'
  );
  assert.ok(bottom.size >= 1 && bottom.size <= 8);
}
