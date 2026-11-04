#!/usr/bin/env node
/**
 * `run_tests` must report what happened, not what a generic error meant.
 *
 * A command that ran and exited 2 has failing tests; "Test command failed to
 * run: Process exited with code 2" sent the model to debug the invocation, and
 * the reason then appeared twice (once as the verdict, once as the output).
 * "Failed to run" belongs to a process that never started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTestsTool } from '../dist/tools/builtin.js';
import { renderCommandResult } from '../dist/tools/test-runners.js';

const ctx = { workspaceDir: '/tmp', sessionKey: 'test', abortSignal: new AbortController().signal };

test('a non-zero exit is a failing run with its output, not a spawn failure', async () => {
  const out = await runTestsTool.execute({ command: 'echo boom >&2; exit 3' }, ctx);
  assert.match(out, /Test Results: ❌ exit 3/);
  assert.match(out, /Output:\nboom/);
  assert.doesNotMatch(out, /failed to run/);
  assert.match(out, /tests_pass=false/);
});

test('a silent non-zero exit says there was no output instead of repeating the error', async () => {
  const out = await runTestsTool.execute({ command: 'node -e "process.exit(2)"' }, ctx);
  assert.match(out, /Test Results: ❌ exit 2/);
  assert.match(out, /\(no output\)/);
  assert.doesNotMatch(out, /Process exited with code 2/);
});

test('exit 0 with no test counts is labeled unknown, not a bare header', () => {
  const out = renderCommandResult('echo all green', 0, 'all green');
  assert.match(out, /Test Results: ⚠️ exit 0, counts unknown/);
  assert.match(out, /tests_pass=false/);
});

test('a node failure is listed once by test name, not three times', () => {
  // Verbatim shape of `node --test` output for one failing test.
  const raw = [
    '✖ adds (1.5ms)',
    'ℹ tests 1',
    'ℹ suites 0',
    'ℹ pass 0',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 81',
    '',
    '✖ failing tests:',
    '',
    'test at test/a.spec.mjs:3:1',
    '✖ adds (1.5ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    '  2 !== 3',
  ].join('\n');
  const out = renderCommandResult('node --test test/a.spec.mjs', 1, raw);
  const listed = out.split('\n').filter((line) => line.startsWith('  • '));
  assert.equal(listed.length, 1, `one failure, not a header or a message; got:\n${out}`);
  assert.match(listed[0], /^ {2}• adds — /);
  assert.doesNotMatch(out, /• failing tests:/);
  assert.doesNotMatch(out, /• \[ERR_ASSERTION\]/);
});

test('a test file that does not exist is not run and is not a failing suite', async () => {
  const out = await runTestsTool.execute({ file: 'no-such-spec.spec.mjs' }, ctx);
  assert.match(out, /Test Results: not run/);
  assert.match(out, /No such test file: no-such-spec\.spec\.mjs\. Nothing was executed\./);
  assert.match(out, /tests_pass=false/);
  assert.doesNotMatch(out, /❌|Could not find/);
});
