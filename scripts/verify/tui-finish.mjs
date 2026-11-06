#!/usr/bin/env node
/**
 * TUI finish polish probe (offline, B168).
 *
 * The first screenshot-driven review found three pieces of end-of-run noise:
 * a tautological `Completed: run finished` line under the `✻ worked for` stamp,
 * the live todo checklist staying expanded forever after the run ended, and a
 * failed exec printing its error message twice (headline + structured result).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const transcript = await load('dist/cli/tui/transcript.js');
const bridge = await load('dist/cli/tui/render-bridge.js');
const markdown = await load('dist/cli/tui/markdown.js');
const outcome = await load('dist/cli/run-outcome.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[tui-finish] ok ${name}`);
};

// 1. A generic completed run keeps only the `✻ worked for` stamp; lines that
//    carry information survive, and the headless line stays mandatory.
assert.equal(
  outcome.outcomeLineForSummary({ status: 'completed', reason: 'run finished' }, 'en'),
  undefined
);
assert.equal(
  outcome.outcomeLineForSummary({ status: 'completed', reason: '运行结束' }, 'zh'),
  undefined
);
assert.match(
  outcome.outcomeLineForSummary({ status: 'completed', reason: 'verification passed' }, 'en'),
  /verification passed/
);
assert.match(
  outcome.outcomeLineForSummary(
    { status: 'unverified', reason: 'claimed checks passed, but no check was run' },
    'en'
  ),
  /^Unverified/
);
assert.equal(
  outcome.formatOutcomeLine({ status: 'completed', reason: 'run finished' }, 'en'),
  'Completed: run finished'
);
ok('a tautological completion line is dropped from the TUI but kept for headless');

// 2. The checklist collapses to one honest line once the run ends.
const done4 = [
  { content: 'write the command-line todo app', status: 'completed' },
  { content: 'verify add/list/done/rm end to end', status: 'completed' },
  { content: 'verify boundary cases', status: 'completed' },
  { content: 'clean test data and check final state', status: 'completed' },
  { content: 'report back to the user', status: 'in_progress' },
];
const finished = transcript.renderTodoPanel(done4, 100, { finished: true });
assert.equal(finished.length, 1, 'a finished run shows the header only');
assert.match(finished[0].text, /4\/5 done · 1 left open when the run ended/);
const allDone = transcript.renderTodoPanel(
  done4.map((todo) => ({ ...todo, status: 'completed' })),
  100,
  { finished: true }
);
assert.equal(allDone.length, 0, 'a fully finished list leaves no panel behind');
const running = transcript.renderTodoPanel(done4, 100);
assert.ok(running.length > 1, 'while running the items stay visible');
assert.match(running[0].text, /4\/5 done/);
ok('the checklist collapses when the run ends (open items are disclosed)');

// 2b. A new run drops the previous run's checklist before the first event.
{
  const store = {
    rows: [],
    todos: [
      { content: 'old finished item', status: 'completed' },
      { content: 'old open item', status: 'in_progress' },
    ],
    usage: { runTokensIn: 10, runTokensOut: 5, tokensIn: 10, tokensOut: 5 },
    run: undefined,
    version: 0,
    nextId: 1,
    contextWarned: false,
  };
  bridge.beginRun(store);
  assert.deepEqual(store.todos, [], 'a new prompt must not inherit the old checklist');
  assert.equal(store.run.running, true);
}
ok("beginRun clears the previous run's checklist");

// 2c. Exec titles and quiet-stream hints read like product copy, not debug logs.
assert.equal(
  transcript.compactExecCommand('cd /private/tmp/ws && ls -l note.txt && wc -c note.txt'),
  'ls -l note.txt && wc -c note.txt'
);
assert.equal(transcript.compactExecCommand("cd '/tmp/my ws'; printf 'hi'"), "printf 'hi'");
assert.equal(transcript.compactExecCommand('npm test'), 'npm test');
assert.equal(
  transcript.toolLabel('exec', { command: 'cd /private/tmp/ws && ls -l a.txt' }),
  'Exec(ls -l a.txt)'
);
assert.equal(transcript.toolLabel('exec', { command: 'npm' }), 'Exec(npm)');
{
  const fs = await import('node:fs');
  const dist = fs.readFileSync(path.join(root, 'dist/cli/tui/transcript.js'), 'utf8');
  assert.match(dist, /no output for \{seconds\}s — Esc to interrupt/);
  assert.doesNotMatch(dist, /stream quiet for \{seconds\}s/);
  const appDist = fs.readFileSync(path.join(root, 'dist/cli/tui/app.js'), 'utf8');
  assert.doesNotMatch(appDist, /context usage will appear after the first response/);
}
ok('exec titles drop the cd prefix and the quiet-stream hint is actionable');

// 2d. Streaming answers never paint a raw fence row.
{
  const streaming = (text) => markdown.renderStreamingMarkdown(text, 80);
  const openBash = streaming('Here is the block:\n```bash\nls -l /tmp\n');
  const openText = openBash.map((entry) => entry.text).join('\n');
  assert.doesNotMatch(openText, /`{3}/, 'the opener is not painted literally');
  assert.match(openText, /│ ls -l \/tmp/);
  assert.match(openText, /┌ bash /);
  const partial = streaming('Running:\n``');
  assert.doesNotMatch(partial.map((entry) => entry.text).join('\n'), /`/);
  const stableFence = streaming('done\n```\nok\n```\n');
  assert.match(stableFence.map((entry) => entry.text).join('\n'), /│ ok/);
}
ok('a streaming answer renders an open fence as a code block, not raw backticks');

// 2e. File tool titles are relative to the workspace, not the absolute path.
{
  const pathModule = await import('node:path');
  const cwd = process.cwd();
  assert.equal(
    transcript.toolLabel('read_file', { file_path: pathModule.join(cwd, 'src/a.ts') }),
    'Read(src/a.ts)'
  );
  assert.equal(
    transcript.toolLabel('write_file', { file_path: pathModule.join(cwd, 'dist', 'x.js') }),
    'Write(dist/x.js)'
  );
  assert.equal(transcript.toolLabel('read_file', { file_path: 'AGENTS.md' }), 'Read(AGENTS.md)');
}
ok('file tool titles are workspace-relative');

// 3. A failed exec states its error once, not twice.
const failed = transcript.renderTranscriptRow(
  {
    id: 7,
    kind: 'result',
    text: [
      'Command failed (exit 1):',
      'ls: /Users/demo/Desktop/todos.json: No such file or directory',
      '-rw-r--r--  1 demo  staff  3009  Nov 14 14:41 /Users/demo/Desktop/todo.py',
    ].join('\n'),
    tool: {
      name: 'exec',
      summary: 'failed — ls: /Users/demo/Desktop/todos.json: No such file or directory',
      isError: true,
      durationMs: 152,
    },
  },
  120
);
const text = failed.map((entry) => entry.text).join('\n');
assert.equal(
  (text.match(/No such file or directory/g) ?? []).length,
  1,
  'the duplicated error message is dropped'
);
assert.match(text, /Command failed \(exit 1\):/, 'the exit-code label stays');
assert.match(text, /todo\.py/, 'real output stays');
assert.match(text, /failed — ls:/, 'the headline stays');
ok('a failed exec prints its error once (label + headline, not the same sentence twice)');

console.log(`[tui-finish] ${checks}/${checks} checks passed`);
