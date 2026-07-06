#!/usr/bin/env node
/**
 * CLI output formatting — tested from the user's perspective:
 * what detail level does the user get in different modes?
 */
import assert from 'node:assert/strict';

import { resolveCliDetailMode, summarizeForCli, createCliRunRenderer } from '../dist/cli/output.js';

// ─── resolveCliDetailMode — detail verbosity selection ───────────────────────

{
  // Default mode (no flags, no env) is 'progress'
  const mode = resolveCliDetailMode([], {});
  assert.equal(mode, 'progress', 'default mode is progress');
}

{
  // --quiet reduces output
  const mode = resolveCliDetailMode(['--quiet'], {});
  assert.equal(mode, 'quiet', '--quiet flag enables quiet mode');
}

{
  // JSON output format implies quiet (machine-readable output)
  const mode = resolveCliDetailMode(['--output-format', 'json'], {});
  assert.equal(mode, 'quiet', 'JSON output mode implies quiet (no decorative output)');
}

{
  const mode = resolveCliDetailMode(['--output-format', 'stream-json'], {});
  assert.equal(mode, 'quiet', 'stream-json output mode implies quiet');
}

{
  // MOSS_CLI_DETAIL env var sets the mode
  const mode = resolveCliDetailMode([], { MOSS_CLI_DETAIL: 'verbose' });
  assert.equal(mode, 'verbose', 'MOSS_CLI_DETAIL=verbose enables verbose mode');
}

{
  const mode = resolveCliDetailMode([], { MOSS_CLI_DETAIL: 'quiet' });
  assert.equal(mode, 'quiet', 'MOSS_CLI_DETAIL=quiet enables quiet mode');
}

{
  // MOSS_VERBOSE_CLI env var
  const mode = resolveCliDetailMode([], { MOSS_VERBOSE_CLI: 'true' });
  assert.equal(mode, 'verbose', 'MOSS_VERBOSE_CLI=true enables verbose mode');
}

// ─── summarizeForCli — tool I/O preview for the CLI ──────────────────────────

{
  // Short values are returned as-is
  const summary = summarizeForCli('hello world');
  assert.ok(summary.includes('hello world'), 'short string is included in summary');
}

{
  // Numbers are stringified
  const summary = summarizeForCli(42);
  assert.ok(summary.includes('42'), 'numbers are converted to string');
}

{
  // null/undefined produce sensible output
  const summary = summarizeForCli(null);
  assert.ok(typeof summary === 'string', 'null produces a string summary');
}

{
  // Long strings are truncated
  const longString = 'A'.repeat(500);
  const summary = summarizeForCli(longString);
  assert.ok(summary.length < longString.length, 'very long string is truncated');
}

{
  // Objects are summarized
  const summary = summarizeForCli({ key: 'value', count: 5 });
  assert.ok(typeof summary === 'string', 'objects produce a string summary');
}

console.log('[PASS] CLI output formatting');

// ─── createCliRunRenderer — oneshot turn_start noise ───────────────────────
// Regression: oneshot/headless mode used to print "- thinking turn 1" on
// EVERY turn (including the first), exposing internal turn jargon and
// cluttering one-shot output. Now turn 1 and turn 2 are silent (a single
// tool call takes 2 turns — no need to announce), and only turn > 2 prints
// a brief "working…" so a multi-step tool loop shows progress.

{
  function makeRenderer(detailMode, interactive) {
    const chunks = [];
    const stderr = { write: (s) => { chunks.push(s); }, isTTY: false };
    const renderer = createCliRunRenderer({ detailMode, interactive, stderr });
    return { renderer, chunks, text: () => chunks.join('') };
  }

  // oneshot (non-verbose, non-interactive): turn 1 MUST be silent.
  {
    const { renderer, text } = makeRenderer('progress', false);
    renderer.handle({ type: 'turn_start', turn: 1 });
    assert.equal(text(), '', 'oneshot turn 1 writes nothing (no "- thinking turn 1" noise)');
  }

  // oneshot: turn 2 also silent (single tool call is 2 turns, normal flow).
  {
    const { renderer, text } = makeRenderer('progress', false);
    renderer.handle({ type: 'turn_start', turn: 2 });
    assert.equal(text(), '', 'oneshot turn 2 is silent (single-tool-call flow)');
  }

  // oneshot: turn > 2 prints a brief progress line.
  {
    const { renderer, text } = makeRenderer('progress', false);
    renderer.handle({ type: 'turn_start', turn: 3 });
    const out = text();
    assert.ok(out.includes('working'), 'oneshot turn 3 uses friendly "working…" wording');
    assert.ok(!/thinking turn/.test(out), 'oneshot turn 3 does NOT use the old "thinking turn" jargon');
  }

  // quiet mode: never prints turn announcements.
  {
    const { renderer, text } = makeRenderer('quiet', false);
    renderer.handle({ type: 'turn_start', turn: 1 });
    renderer.handle({ type: 'turn_start', turn: 2 });
    renderer.handle({ type: 'turn_start', turn: 3 });
    assert.equal(text(), '', 'quiet mode suppresses all turn_start output');
  }

  // verbose mode: still prints the detailed "thinking (turn N)" line.
  {
    const { renderer, text } = makeRenderer('verbose', false);
    renderer.handle({ type: 'turn_start', turn: 1 });
    const out = text();
    assert.ok(/thinking/.test(out) && out.includes('turn 1'), 'verbose mode prints "thinking (turn 1)"');
  }
}

console.log('[PASS] CLI oneshot turn_start noise suppression');
