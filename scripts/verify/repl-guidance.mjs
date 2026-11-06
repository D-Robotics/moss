#!/usr/bin/env node
/**
 * REPL guidance probe (offline, B156).
 *
 * The audit's why-design pass found the interactive help and hints stale:
 * `/run` advertised `<condition> | clear` while the parser accepted
 * `resume`/`--accept`, `/help` said only "Ctrl+C exit" (Ctrl+C actually pauses
 * a run and Esc interrupts), and a goal run never said how to stop it.
 *
 * The mode-aware prompt and the Esc handling are covered by a real PTY run in
 * the backlog evidence; this probe locks the surfaces that are checkable
 * offline: the catalog args, the localized help block, and the run-start hint.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[repl-guidance] ok ${name}`);
};

const interactive = await load('dist/cli/interactive-commands.js');
const rows = interactive.INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows);
const goal = rows.find((row) => row.command === '/goal');
assert.ok(goal, '/goal must stay in the catalog');
assert.match(goal.args, /resume/);
assert.match(goal.args, /--accept/);
assert.match(goal.args, /resume \[task_id\]/);
assert.deepEqual(goal.aliases, ['/run']);
ok('/goal advertises the real syntax (resume, --accept) and keeps /run as an alias');

// Render /help in both locales directly; the function takes an explicit locale
// so this never depends on the runner's language configuration.
const onboarding = await load('dist/cli/onboarding.js');
const en = onboarding.renderCliInteractiveHelp('en');
assert.match(en, /Ctrl\+C \(idle\)\s+exit/);
assert.match(en, /Ctrl\+C \(run in progress\)\s+pause, then \/goal resume continues/);
assert.match(en, /Esc \(run in progress\)\s+interrupt the turn/);
assert.match(en, /Up \/ Down\s+prompt history/);
const zh = onboarding.renderCliInteractiveHelp('zh');
assert.match(zh, /Ctrl\+C（运行中）/);
assert.match(zh, /\/goal resume/);
assert.match(zh, /Esc（运行中）/);
ok(
  '/help explains idle exit, run pause (with /goal resume), Esc interrupt and history in both locales'
);

// The run-start hint is a user-facing constant in the REPL module; a missing
// string means the hint silently disappeared.
const replSource = fs.readFileSync(path.join(root, 'dist/cli/repl.js'), 'utf8');
assert.match(replSource, /Ctrl\+C pauses \(\/goal resume to continue\) · Esc interrupts/);
assert.match(replSource, /Ctrl\+C 暂停（\/goal resume 续跑）· Esc 中断/);
assert.match(replSource, /modePrompt/, 'the mode-aware prompt helper must stay wired');
ok('a goal run announces "Ctrl+C pauses · Esc interrupts" and the prompt is mode-aware');

console.log(`[repl-guidance] ${checks}/${checks} checks passed`);
