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
const renderer = await load('dist/cli/tui/renderer.js');
const statusLine = await load('dist/cli/status-line.js');
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
  assert.match(openText, /┌ bash$/m, 'the frame header is a short label, not a rule');
  assert.doesNotMatch(openText, /─{10,}/);
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

// 2f. A successful exec collapses to headline + one output line (B185).
{
  const row = transcript.renderTranscriptRow(
    {
      id: 9,
      kind: 'result',
      text: ['total 0', 'file a', 'file b', 'file c', 'file d'].join('\n'),
      tool: { name: 'exec', summary: 'ok', isError: false, durationMs: 30 },
    },
    120
  );
  const lines = row.map((entry) => entry.text);
  assert.ok(lines.length <= 4, `successful exec should be compact, got ${lines.length} lines`);
  assert.match(lines.join('\n'), /total 0/);
  assert.match(lines.join('\n'), /more lines · ctrl\+o/);
}
ok('a successful exec folds to one preview line; the rest stays behind ctrl+o');

// 2g. B189: a self-audit aside is dim and one line, not a bright markdown block.
{
  const asideRow = transcript.renderTranscriptRow(
    {
      id: 10,
      kind: 'assistant',
      text: '**Spec audit:** no docs exist in this workspace, so no SPEC-AUDIT.md is needed.',
    },
    120
  );
  const asideBody = asideRow.filter((entry) => entry.text.trim() !== '');
  assert.equal(asideBody.length, 1, 'the aside folds to one content row');
  assert.equal(asideBody[0].dim, true, 'the aside is dim');
  assert.doesNotMatch(asideBody[0].text, /\*\*/);
  assert.match(asideBody[0].text, /Spec audit: no docs exist/);
  const verboseAside = transcript.renderTranscriptRow(
    {
      id: 11,
      kind: 'assistant',
      text: '**Spec audit:** no docs exist in this workspace, so no SPEC-AUDIT.md is needed.',
    },
    120,
    true
  );
  assert.ok(
    verboseAside.some((entry) => entry.text.includes('Spec audit: no docs exist')),
    'verbose keeps the full text'
  );
  assert.ok(
    !verboseAside.some((entry) => entry.text.trim() !== '' && entry.dim),
    'verbose is not collapsed to a dim aside'
  );
  const normal = transcript.renderTranscriptRow(
    { id: 12, kind: 'assistant', text: 'Spec audit is not part of this answer at all.' },
    120
  );
  assert.ok(
    !normal.some((entry) => entry.text.trim() !== '' && entry.dim),
    'a normal answer stays bright'
  );
}
ok('a self-audit aside folds to one dim line; verbose and normal answers keep their shape');

// 2h. B192: a read-only result is one row (count + ctrl+o on the headline), and a
//     todo_write result folds to its progress instead of reprinting the checklist.
{
  const readRow = transcript.renderTranscriptRow(
    {
      id: 20,
      kind: 'result',
      text: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'].join('\n'),
      tool: { name: 'read_file', summary: 'Read 7 lines', durationMs: 42, isError: false },
    },
    120
  );
  const readBody = readRow.filter((entry) => entry.text.trim() !== '');
  assert.equal(readBody.length, 1, `a 7-line read must be one row, got ${readBody.length}`);
  assert.match(readBody[0].text, /Read 7 lines/);
  assert.match(readBody[0].text, /ctrl\+o/);
  assert.doesNotMatch(readBody[0].text, /7 lines · 7 lines/);

  const todoRow = transcript.renderTranscriptRow(
    {
      id: 21,
      kind: 'result',
      text: [
        '1. ✓ first [completed]',
        '2. ◐ second [in_progress]',
        '3. ○ third [pending]',
        '',
        'Progress: 1/3 complete.',
      ].join('\n'),
      tool: { name: 'todo_write', summary: 'Todo list updated', durationMs: 3, isError: false },
    },
    120
  );
  const todoBody = todoRow.filter((entry) => entry.text.trim() !== '');
  assert.equal(todoBody.length, 1, `todo_write folds to one row, got ${todoBody.length}`);
  assert.match(todoBody[0].text, /1\/3 done/);
  assert.doesNotMatch(todoBody[0].text, /first \[completed\]/);
}
ok('read results are one row and todo_write folds to progress (B192)');

// 2i. B193: a streamed list split into continuation rows keeps its items together
//     (no blank paragraph between bullets), while separate paragraphs still gap.
{
  const first = { id: 30, kind: 'assistant', text: '- a.txt → 1' };
  const second = { id: 31, kind: 'assistant', text: '- b.txt → 2', continuation: true };
  const third = { id: 32, kind: 'assistant', text: '- c.txt → 3', continuation: true };
  assert.equal(transcript.isListContinuation(second, first), true);
  const secondRows = transcript.renderTranscriptRow(second, 120, false, first);
  assert.ok(
    !secondRows.some((entry) => entry.text.trim() === ''),
    'a list continuation must not start with a blank line'
  );
  assert.match(secondRows.map((entry) => entry.text).join('\n'), /- b\.txt → 2/);
  assert.equal(
    transcript.isListContinuation(second, third),
    true,
    'order does not matter for the rule'
  );
  const paragraph = {
    id: 33,
    kind: 'assistant',
    text: 'A separate paragraph.',
    continuation: true,
  };
  assert.equal(transcript.isListContinuation(paragraph, first), false);
  assert.ok(
    transcript
      .renderTranscriptRow(paragraph, 120, false, first)
      .some((entry) => entry.text.trim() === ''),
    'a paragraph continuation keeps its blank line'
  );
}
ok('streamed list items stay together; paragraph continuations keep their gap');

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

// 5b. B196: the exit hint names the action, not just the command.
{
  const exit = renderer.tuiExitSequence('inline');
  assert.match(exit, /(?:Resume this session|继续本次会话)[:：]? ?moss --continue/);
}
ok('the inline exit hint says what `moss --continue` does');

// 6. B194: the status row labels each number instead of imploding.
{
  const en = statusLine.formatStatusLine({
    model: 'm',
    cwd: '~/proj',
    tokensIn: 9_700,
    tokensOut: 161,
    contextPct: 2,
  });
  assert.match(en, /in 9\.7k · out 161/);
  assert.match(en, /ctx 2%/);
  const zh = statusLine.formatStatusLine({
    model: 'm',
    cwd: '~/proj',
    tokensIn: 9_700,
    tokensOut: 161,
    contextPct: 2,
    zh: true,
  });
  assert.match(zh, /入 9\.7k · 出 161/);
  assert.match(zh, /上下文 2%/);
  const waitLine = await load('dist/cli/run-progress.js');
  assert.match(waitLine.formatThinkingWaitLine(60_000, false), /^Waiting on the model, 60s$/);
  assert.match(waitLine.formatThinkingWaitLine(60_000, true), /^等待模型响应，已 60s$/);
}
ok('the status row labels in/out/ctx and a long wait names the model');

console.log(`[tui-finish] ${checks}/${checks} checks passed`);
