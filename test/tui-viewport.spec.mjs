#!/usr/bin/env node
/** Viewport stays inside its window and keeps the anchor across resize. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createViewport,
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
  const all = lines(10_000);
  const start = performance.now();
  viewportWindow(all, scrollViewport(createViewport(), all.length, -20, 24), 24);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5, `scroll ${elapsed.toFixed(2)}ms`);
}
