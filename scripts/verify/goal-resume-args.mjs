#!/usr/bin/env node
/**
 * `/goal resume ... --accept` / `--max-repairs` / `--max-turns` probe (offline).
 *
 * B98 taught `moss task resume` to correct a broken acceptance oracle, but the
 * interactive `/goal resume` parsed only the bare word: the CLI-side fix was
 * unreachable from the REPL/TUI, and the blocked notice still pointed there.
 * B114 then gave a resume its own retry budget, and `/goal resume` again could
 * not express it — the flag parity broke exactly on the path the Ctrl+C/Esc
 * notice advertises. This locks the argument grammar, the `/task` hand-off
 * string, and that the hand-off survives the real CLI flag parser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { planGoalInvocation, goalResumeArgs, goalResumeDispatchArgs, resumeEchoLine, GOAL_USAGE } =
  await load('dist/cli/commands/goal-propose.js');
const { splitCommandArgs, parseFlags } = await load('dist/cli/task-run.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[goal-resume-args] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-goalresume-'));
const plan = (line) => planGoalInvocation(line, tmp);

// --- B98: the oracle correction stays intact -------------------------------
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

assert.deepEqual(plan('resume --accept grep -q x f.txt'), {
  kind: 'resume',
  acceptance: 'grep -q x f.txt',
});
ok('an unquoted multi-word `--accept` still takes the rest of the line');

// --- B117: the retry budget is expressible interactively -------------------
assert.deepEqual(plan('resume --max-repairs 0 --max-turns 1'), {
  kind: 'resume',
  maxRepairs: 0,
  maxTurns: 1,
});
assert.deepEqual(plan('resume --max-turns 2 --max-repairs 0'), {
  kind: 'resume',
  maxRepairs: 0,
  maxTurns: 2,
});
ok('`--max-repairs` / `--max-turns` parse in either order and keep 0');

assert.deepEqual(plan('resume --max-repairs 3 task_abc --max-turns 2'), {
  kind: 'resume',
  taskId: 'task_abc',
  maxRepairs: 3,
  maxTurns: 2,
});
assert.deepEqual(plan("resume task_abc --accept 'test -f note.txt' --max-repairs 0"), {
  kind: 'resume',
  taskId: 'task_abc',
  acceptance: 'test -f note.txt',
  maxRepairs: 0,
});
ok('a task id and `--accept` combine with the budget flags in any order');

assert.deepEqual(plan('resume --max-repairs=0 --max-turns=4'), {
  kind: 'resume',
  maxRepairs: 0,
  maxTurns: 4,
});
ok('`--flag=value` is accepted like the CLI parser does');

// --- strictness: bad budgets are usage errors, not silent runs -------------
for (const bad of [
  'resume --max-repairs abc',
  'resume --max-repairs -1',
  'resume --max-repairs 1.5',
  'resume --max-repairs',
  'resume --max-turns',
  'resume --max-repairs 1 --max-repairs 2',
  'resume --max-turns 1 --max-turns 2',
  'resume --accept a --accept b',
  'resume --wat 3',
  'resume task_abc --wat',
]) {
  assert.equal(plan(bad).kind, 'usage', `expected usage for: ${bad}`);
}
assert.deepEqual(plan('resume task_abc'), { kind: 'resume', taskId: 'task_abc' });
ok('malformed flags/values/repeats are a usage error, not a silent run');

assert.equal(plan('fix the flaky test --accept "npm test"').kind, 'run');
assert.match(GOAL_USAGE, /\/run resume \[task_id\]/);
assert.match(GOAL_USAGE, /--max-repairs N/);
assert.match(GOAL_USAGE, /--max-turns N/);
ok('the original `/goal <condition> --accept` path is intact and usage names both flags');

// --- hand-off: the `/task resume ...` string round-trips ------------------
const args = splitCommandArgs(goalResumeArgs({ acceptance: 'grep -q x f.txt' }));
assert.deepEqual(args, ['resume', '--accept', 'grep -q x f.txt']);
const withId = splitCommandArgs(
  goalResumeArgs({ taskId: 'task_abc', acceptance: 'grep -q x f.txt' })
);
assert.deepEqual(withId, ['resume', 'task_abc', '--accept', 'grep -q x f.txt']);
ok('the `/task` hand-off string survives quoting and re-parsing');

const budgeted = goalResumeArgs({
  taskId: 'task_abc',
  acceptance: 'test -f note.txt',
  maxRepairs: 0,
  maxTurns: 1,
});
assert.equal(
  budgeted,
  'resume task_abc --accept "test -f note.txt" --max-repairs 0 --max-turns 1',
  'stable flag order: taskId, --accept, --max-repairs, --max-turns'
);
// The dispatch check: the same string must pass the real CLI flag parser that
// `moss task resume` uses, otherwise `/goal resume` still cannot express it.
// `moss task resume` parses `commandArgs.slice(1)` (past the subcommand), so
// the probe does the same: this is the exact call the CLI makes.
const forwarded = parseFlags(splitCommandArgs(budgeted).slice(1));
assert.deepEqual(forwarded.goal, ['task_abc']);
assert.equal(forwarded.accept, 'test -f note.txt');
assert.equal(forwarded.maxRepairs, 0);
assert.equal(forwarded.maxTurns, 1);
const flagsOnly = parseFlags(
  splitCommandArgs(goalResumeArgs({ maxRepairs: 0, maxTurns: 2 })).slice(1)
);
assert.deepEqual(flagsOnly.goal, [], 'no id: the REPL resolves the newest task itself');
assert.equal(flagsOnly.maxRepairs, 0);
assert.equal(flagsOnly.maxTurns, 2);
ok('the generated `/task resume ...` line parses through the real CLI flags (dispatch)');

// --- the REPL/TUI call site itself: one helper, the resolved id wins --------
const dispatched = goalResumeDispatchArgs(
  { kind: 'resume', acceptance: 'test -f note.txt', maxRepairs: 0, maxTurns: 1 },
  'task_latest'
);
assert.equal(
  dispatched,
  'resume task_latest --accept "test -f note.txt" --max-repairs 0 --max-turns 1',
  'the REPL resolves the newest resumable id and applies the flags to that task'
);
assert.equal(goalResumeDispatchArgs({ kind: 'resume', taskId: 'task_abc' }), 'resume task_abc');
assert.equal(
  goalResumeDispatchArgs({ kind: 'resume', taskId: 'task_typed', maxRepairs: 2 }, 'task_latest'),
  'resume task_latest --max-repairs 2',
  'a resolved id wins over the typed one, like the REPL resolution'
);
const dispatchedFlags = parseFlags(splitCommandArgs(dispatched).slice(1));
assert.equal(dispatchedFlags.goal[0], 'task_latest');
assert.equal(dispatchedFlags.maxRepairs, 0);
assert.equal(dispatchedFlags.maxTurns, 1);
ok('the interactive dispatch line carries the budget onto the resolved task');

// --- the pre-run echo: which task the id-less form resolved to, what budget --
assert.equal(
  resumeEchoLine('task_abc', { maxRepairs: 0, maxTurns: 1 }, false),
  'Resuming task_abc — repair budget 0, turn budget 1'
);
assert.equal(
  resumeEchoLine('task_abc', { maxRepairs: 0, maxTurns: 1 }, true),
  '继续 task_abc — 修复预算 0、回合预算 1'
);
assert.equal(
  resumeEchoLine('task_abc', { acceptance: 'test -f x' }, false),
  'Resuming task_abc — corrected acceptance command',
  'a corrected oracle is mentioned without echoing the whole command'
);
assert.equal(
  resumeEchoLine('task_abc', { acceptance: 'test -f x', maxTurns: 3 }, true),
  '继续 task_abc — 回合预算 3、已改正验收命令'
);
assert.equal(resumeEchoLine('task_abc', {}, false), 'Resuming task_abc');
assert.equal(resumeEchoLine('task_latest', { maxTurns: 2 }, true), '继续 task_latest — 回合预算 2');
ok('the REPL echoes the resolved task and the retry budget before it runs');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[goal-resume-args] ${checks}/${checks} checks passed`);
