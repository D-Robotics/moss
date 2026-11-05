#!/usr/bin/env node
/**
 * run_tests verdict probe.
 *
 * A test command's exit code is the verdict (Claude Code / Cursor behavior);
 * the framework output is display sugar. The tool used to report
 * `tests_pass=false` for a green custom runner just because its output was not
 * one of the parsed frameworks, which made the model prove a green run a second
 * time with exec and would have recorded a false negative in the acceptance
 * ledger. This probe pins both directions:
 *
 *   - exit 0 + unparsed output   -> tests_pass=true, counts-unknown caveat
 *   - exit 1                     -> tests_pass=false
 *   - recognized runner          -> counts stay parsed (no regression)
 *   - timeout / spawn failure    -> tests_pass=false
 *   - no runner / not started    -> tests_pass=false (unchanged)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const runners = await import(pathToFileURL(path.join(root, 'dist/tools/test-runners.js')).href);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-run-tests-'));
const write = (name, content) => fs.writeFileSync(path.join(workspace, name), content);

write('custom-green.mjs', "console.log('ALL GREEN: 12 assertions passed in my own reporter');\n");
write('custom-red.mjs', "console.error('boom: assertion failed');\nprocess.exit(1);\n");
write(
  'node-test.mjs',
  "import test from 'node:test';\nimport assert from 'node:assert';\ntest('one plus one', () => { assert.equal(1 + 1, 2); });\n"
);
write('slow.mjs', 'setTimeout(() => process.exit(0), 1500);\n');

const ctx = { workspaceDir: workspace };
const debug = process.env.MOSS_VERIFY_RUN_TESTS_DEBUG === '1';
const run = async (input, timeoutMs = 20_000) => {
  const started = Date.now();
  const text = await runners.runWorkspaceTests(ctx, input, timeoutMs);
  if (debug)
    console.error(`[run-tests-verdict] debug ${Date.now() - started}ms ${JSON.stringify(input)}`);
  return text;
};

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[run-tests-verdict] ok ${name}`);
};

// 1. Green custom runner: exit code is the verdict, counts are a caveat.
const green = await run({ command: 'node custom-green.mjs' });
assert.match(green, /tests_pass=true/);
assert.match(green, /exit 0 \(pass\/fail counts could not be parsed\)/);
assert.match(green, /exited 0, so this is recorded as a passing run/);
assert.doesNotMatch(green, /tests_pass=false/);
ok('exit 0 with an unparsed custom reporter is a pass with a counts caveat');

// 2. Red custom runner still fails.
const red = await run({ command: 'node custom-red.mjs' });
assert.match(red, /tests_pass=false/);
assert.match(red, /❌ exit 1/);
assert.doesNotMatch(red, /tests_pass=true/);
ok('a non-zero exit is still a failure');

// 3. A recognized reporter keeps its parsed counts (no regression).
const known = await run({ file: 'node-test.mjs' });
assert.match(known, /tests_pass=true/);
assert.doesNotMatch(known, /could not be parsed/);
assert.match(known, /pass(ed)?\s*1|1\s+pass/);
ok('recognized runner counts are still parsed');

// 4. Timeout stays a failure.
const timedOut = await run({ command: 'node slow.mjs' }, 200);
assert.match(timedOut, /timed out/);
assert.match(timedOut, /tests_pass=false/);
ok('timeout is still a failure');

// 5. A spawn failure stays a failure.
const missing = await run({ command: 'definitely-not-a-test-binary-xyz' });
assert.match(missing, /tests_pass=false/);
ok('a command that cannot run is still a failure');

// 6. The intended guards are unchanged: no suite target / bare call.
const noRunnerWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-run-tests-empty-'));
const timed = async (label, input, timeoutMs) => {
  const started = Date.now();
  const text = await runners.runWorkspaceTests(
    { workspaceDir: noRunnerWorkspace },
    input,
    timeoutMs
  );
  if (debug) console.error(`[run-tests-verdict] debug ${Date.now() - started}ms ${label}`);
  return text;
};
const noRunner = await timed('suite-empty', { suite: true }, 5_000);
assert.match(noRunner, /tests_pass=false/);
assert.match(noRunner, /no runner detected/);
const notStarted = await runners.runWorkspaceTests({ workspaceDir: noRunnerWorkspace }, {}, 5_000);
assert.match(notStarted, /not started/);
assert.match(notStarted, /tests_pass=false/);
ok('no-runner and not-started guards are unchanged');

console.log(`[run-tests-verdict] ${checks}/${checks} checks passed`);
if (process.env.MOSS_VERIFY_RUN_TESTS_DEBUG === '1') {
  console.error(`[run-tests-verdict] debug total ${Date.now()} - ${performance.timeOrigin}`);
  console.error(
    `[run-tests-verdict] debug resources ${JSON.stringify(process.getActiveResourcesInfo())}`
  );
  process.exit(0);
}
