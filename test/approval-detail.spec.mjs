#!/usr/bin/env node
/**
 * diffLinesForApproval — the LCS-based unified-diff helper reused by the TUI's
 * ActivityItemLine to render edit_file results as a colored inline diff
 * (parity with apply_patch). Tested from the user's perspective: when the
 * agent runs edit_file, can the user see what changed?
 *
 * Lines are prefixed:
 *   '- '      removed
 *   '+ '      added
 *   '  … (N unchanged lines)'  collapsed context run
 *
 * Returns null when either input exceeds MAX_DIFF_INPUT_LINES (400), so the
 * caller falls through to a summary instead of dumping a huge diff.
 */
import assert from 'node:assert/strict';

import { diffLinesForApproval } from '../dist/cli/approval-detail.js';

// ─── basic replacement ─────────────────────────────────────────────────────

{
  const oldText = 'line one\nline two\nline three';
  const newText = 'line one\nline TWO\nline three';
  const diff = diffLinesForApproval(oldText, newText);
  assert.ok(Array.isArray(diff), 'returns an array for a normal edit');
  assert.ok(
    diff.some((l) => l === '- line two'),
    'removed old line present'
  );
  assert.ok(
    diff.some((l) => l === '+ line TWO'),
    'added new line present'
  );
  assert.ok(
    diff.some((l) => l.startsWith('  … (') && l.includes('unchanged')),
    'unchanged context collapsed into an ellipsis run'
  );
  // 'line one' matches before the change, 'line three' matches after — the
  // change splits the unchanged lines into two separate collapsed runs.
  const ctx = diff.filter((l) => l.startsWith('  … ('));
  assert.equal(ctx.length, 2, 'two collapsed context runs (before and after the change)');
  assert.ok(ctx[0].includes('1 unchanged line'), 'first context run is the line before the change');
  assert.ok(ctx[1].includes('1 unchanged line'), 'second context run is the line after the change');
}

// ─── pure insertion ────────────────────────────────────────────────────────

{
  const oldText = 'a\nb';
  const newText = 'a\nNEW\nb';
  const diff = diffLinesForApproval(oldText, newText);
  assert.ok(
    diff.some((l) => l === '+ NEW'),
    'inserted line marked with +'
  );
  assert.ok(!diff.some((l) => l.startsWith('- ')), 'no removed lines on pure insertion');
  assert.ok(
    diff.some((l) => l.startsWith('  … (') && l.includes('unchanged')),
    'surrounding unchanged context collapsed'
  );
}

// ─── pure deletion ────────────────────────────────────────────────────────

{
  const oldText = 'a\nDELETE\nb';
  const newText = 'a\nb';
  const diff = diffLinesForApproval(oldText, newText);
  assert.ok(
    diff.some((l) => l === '- DELETE'),
    'deleted line marked with -'
  );
  assert.ok(!diff.some((l) => l.startsWith('+ ')), 'no added lines on pure deletion');
}

// ─── identical input → no - / + lines ─────────────────────────────────────

{
  const same = 'same\ncontent\nhere';
  const diff = diffLinesForApproval(same, same);
  assert.ok(diff !== null, 'identical input still returns an array');
  assert.ok(!diff.some((l) => l.startsWith('- ')), 'no removed lines when identical');
  assert.ok(!diff.some((l) => l.startsWith('+ ')), 'no added lines when identical');
  assert.ok(
    diff.every((l) => l.startsWith('  … (')),
    'all lines are collapsed context'
  );
}

// ─── large input → null (caller falls back to summary) ────────────────────

{
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const out = diffLinesForApproval(big, big + '\nextra');
  assert.equal(out, null, '>400 lines returns null so the TUI renders a summary, not a huge diff');
}

// ─── empty old string (creation-style edit) ───────────────────────────────

{
  // Note: ''.split('\n') yields [''] (one empty element), so the LCS diff
  // treats empty old text as a single empty line and emits a '- ' line for it.
  // edit_file itself rejects an empty old_string, so this edge case never
  // reaches the TUI's edit_file rendering — we only assert the new content
  // is surfaced with a '+' marker.
  const diff = diffLinesForApproval('', 'brand new content');
  assert.ok(diff !== null, 'empty old string returns an array');
  assert.ok(
    diff.some((l) => l === '+ brand new content'),
    'new content marked with +'
  );
}

console.error('approval-detail: diffLinesForApproval produces correct +/-/context lines ✓');
