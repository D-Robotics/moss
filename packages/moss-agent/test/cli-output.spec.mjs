#!/usr/bin/env node
/**
 * CLI output formatting — tested from the user's perspective:
 * what detail level does the user get in different modes?
 */
import assert from 'node:assert/strict';

import { resolveCliDetailMode, summarizeForCli } from '../dist/cli/output.js';

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
