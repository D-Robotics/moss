#!/usr/bin/env node
/**
 * `/goal resume ... --accept` parser probe (offline).
 *
 * B98 taught `moss task resume` to correct a broken acceptance oracle, but the
 * interactive `/goal resume` parsed only the bare word: the CLI-side fix was
 * unreachable from the REPL/TUI, and the blocked notice still pointed there.
 * This locks the argument grammar and the `/task` hand-off string.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { planGoalInvocation, goalResumeArgs, GOAL_USAGE } = await load(
  'dist/cli/commands/goal-propose.js'
);
const { splitCommandArgs } = await load('dist/cli/task-run.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[goal-resume-args] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-goalresume-'));
const plan = (line) => planGoalInvocation(line, tmp);

assert.deepEqual(plan('resume'), { kind: 'resume' });
ok('bare `/goal resume` keeps picking the newest resumable task');

assert.deepEqual(plan('resume --accept "true"'), {
  kind: 'resume',
  acceptance: 'true',
});
assert.deepEqual(plan("resume task_abc --accept='grep -q x f.txt'"), {
  kind: 'resume',
  taskId: 'task_abc',
  acceptance: 'grep -q x f.txt',
});
ok('`/goal resume [id] --accept "<cmd>"` names both the task and the new oracle');

assert.deepEqual(plan('resume task_abc'), { kind: 'resume', taskId: 'task_abc' });
assert.equal(plan('resume a b').kind, 'usage');
assert.equal(plan('resume --accept').kind, 'usage');
ok('malformed resume lines are a usage error, not a silent run');

assert.equal(plan('fix the flaky test --accept "npm test"').kind, 'run');
assert.match(GOAL_USAGE, /\/goal resume \[task_id\]/);
ok('the original `/goal <condition> --accept` path and usage text are intact');

const args = splitCommandArgs(goalResumeArgs({ acceptance: 'grep -q x f.txt' }));
assert.deepEqual(args, ['resume', '--accept', 'grep -q x f.txt']);
const withId = splitCommandArgs(
  goalResumeArgs({ taskId: 'task_abc', acceptance: 'grep -q x f.txt' })
);
assert.deepEqual(withId, ['resume', 'task_abc', '--accept', 'grep -q x f.txt']);
ok('the `/task` hand-off string survives quoting and re-parsing');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[goal-resume-args] ${checks}/5 checks passed`);
