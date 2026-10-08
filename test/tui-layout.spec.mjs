#!/usr/bin/env node
/** Dynamic region stays inside the terminal (S3). */
import assert from 'node:assert/strict';
import { allocateFrame } from '../dist/cli/tui/layout.js';

function section(id, count, priority, min = 0) {
  return {
    id,
    lines: Array.from({ length: count }, (_, index) => ({ text: `${id}-${index}` })),
    min,
    priority,
    trim: id === 'live' ? 'tail' : 'head',
  };
}

for (let rows = 6; rows <= 60; rows += 1) {
  for (const combo of [
    [section('dialog', 8, 0, 2), section('live', 20, 5, 1)],
    [
      section('overlay', 12, 1),
      section('todo', 6, 3),
      section('queue', 3, 4),
      section('live', 30, 5, 1),
    ],
    [section('status-notes', 4, 2), section('live', 4, 5, 1)],
  ]) {
    const layout = allocateFrame({
      rows,
      mode: 'inline',
      composerLines: 2,
      fixedChrome: 4,
      sections: combo,
    });
    assert.ok(
      layout.dynamicRows <= rows - 1 || rows < 8,
      `inline rows=${rows} dynamic=${layout.dynamicRows}`
    );
    const dialog = layout.sections.find((entry) => entry.id === 'dialog');
    if (dialog && combo.some((entry) => entry.id === 'dialog' && entry.lines.length > 0)) {
      assert.ok(dialog.lines.length >= 1 || rows < 10);
    }
  }
  const full = allocateFrame({
    rows,
    mode: 'fullscreen',
    composerLines: 2,
    fixedChrome: 4,
    sections: [section('dialog', 6, 0, 1), section('live', 40, 5, 1)],
  });
  assert.ok(full.viewportRows >= 3);
}
