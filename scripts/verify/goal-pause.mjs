#!/usr/bin/env node
/**
 * Pause-notice probe (pure renderer, offline).
 *
 * Ctrl+C during `/goal` used to kill the CLI with no way back. The notice now
 * says the run was paused (not failed), names the task, and prints both resume
 * paths. The PTY behaviour is proven separately; this locks the wording and the
 * "no resumable task" branch.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { renderPausedGoalLines } = await import(
  pathToFileURL(path.join(root, 'dist/cli/goal-pause.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[goal-pause] ok ${name}`);
};

const candidate = { taskId: 'task-abc123', goal: 'make the tests pass', phase: 'paused' };
const en = renderPausedGoalLines(candidate, 'en');
assert.ok(en.length >= 3);
assert.ok(en[0].includes('paused by user'), 'says paused, not failed');
assert.ok(!/failed by user/i.test(en[0]));
assert.ok(en[1].includes('task-abc123') && en[1].includes('paused'));
assert.ok(en[1].includes('make the tests pass'));
assert.ok(en[2].includes('/goal resume'));
assert.ok(en[2].includes('/task resume task-abc123'));
assert.ok(en[2].includes('/goal clear'));
ok('en notice names the pause, the task and both resume paths');

const longGoal = `${'x'.repeat(120)}tail`;
const truncated = renderPausedGoalLines({ ...candidate, goal: longGoal }, 'en')[1];
assert.ok(truncated.includes('…'), 'long goals are truncated');
assert.ok(!truncated.includes('tail'), 'the truncated part is not shown');
ok('long goals are truncated without losing the task identity');

const zh = renderPausedGoalLines(candidate, 'zh');
assert.ok(zh[0].includes('已暂停'));
assert.ok(zh[1].includes('task-abc123'));
assert.ok(zh[2].includes('/goal resume'));
ok('zh notice is localized');

const empty = renderPausedGoalLines(null, 'en');
assert.ok(empty[0].includes('no resumable task state'));
assert.ok(empty[1].includes('/goal <condition>'));
ok('no-candidate branch says there is nothing to resume');

console.log(`[goal-pause] ${checks}/4 checks passed`);
