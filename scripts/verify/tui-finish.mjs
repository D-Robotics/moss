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

// B284: the nightly Windows leg reported only "probe exited 1: …", because the
// verify runner keeps the LAST stderr line. Print the crash as one line so the
// next nightly names the failing check.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (error) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[tui-finish] ${signal}: ${text.replace(/\n/g, ' ⏎ ')}`);
    process.exit(1);
  });
}

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const transcript = await load('dist/cli/tui/transcript.js');
const renderer = await load('dist/cli/tui/renderer.js');
const toolSummary = await load('dist/cli/tui/tool-summary.js');
const promptHistory = await load('dist/cli/tui/prompt-history.js');
const appHelpers = await load('dist/cli/tui/app-helpers.js');
const agentFiles = await load('dist/core/subagent/agent-file-loader.js');
const permissionsPanel = await load('dist/cli/tui/permissions-panel.js');
const renderBridge = await load('dist/cli/tui/render-bridge.js');
const statusLine = await load('dist/cli/status-line.js');
const interactionMode = await load('dist/cli/interaction-mode.js');
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

// 5c. B219: an empty search body ("No files found") is not "Found 1 match".
{
  const empty = toolSummary.summarizeToolCompletion(
    'search_files',
    { path: '.' },
    'No files found',
    false
  );
  assert.equal(empty.summary, 'No matches');
  assert.doesNotMatch(empty.summary, /Found \d+ match/);
  const one = toolSummary.summarizeToolCompletion(
    'search_files',
    { path: '.' },
    'a.js:1: hit',
    false
  );
  assert.match(one.summary, /Found 1 match/);
}
ok('an empty search summary says No matches, not Found 1 match');

// 5d. B219: the plan gate's status hint matches its dialog footer (Esc keeps
//     planning), instead of the generic "Esc to skip".
{
  const base = {
    blocked: true,
    dialogKind: 'question',
    dialogHasOptions: true,
    answerKeys: '1/2/3',
    mode: 'plan',
    running: false,
  };
  const custom = transcript.renderHint({ ...base, dialogEscHint: 'Esc keeps planning' }, 160).text;
  assert.match(custom, /Esc keeps planning/);
  assert.doesNotMatch(custom, /Esc to skip/);
  const generic = transcript.renderHint(base, 160).text;
  assert.match(generic, /Esc to skip/);
}
ok('the status row can say "Esc keeps planning" for the plan gate');

// 5e. B220: pre-tool narration folds to one dim line; the answer stays full and
//     `exit_plan` prints a receipt instead of repeating the plan.
{
  const narration = {
    id: 40,
    kind: 'assistant',
    text: "I'll read both files first, then make the changes.",
    progress: true,
  };
  const folded = transcript.renderTranscriptRow(narration, 120).filter((r) => r.text.trim());
  assert.equal(folded.length, 1);
  assert.equal(folded[0].dim, true);
  assert.match(folded[0].text, /I'll read both files first/);
  const verbose = transcript.renderTranscriptRow(narration, 120, true).filter((r) => r.text.trim());
  assert.ok(!verbose.every((r) => r.dim), 'verbose does not dim narration');

  const store = { rows: [{ id: 1, kind: 'assistant', text: 'progress' }], version: 0 };
  renderBridge.markProgressNarration(store);
  assert.equal(store.rows[0].progress, true);
  const userStore = { rows: [{ id: 2, kind: 'user', text: 'hi' }], version: 0 };
  renderBridge.markProgressNarration(userStore);
  assert.equal(userStore.rows[0].progress, undefined, 'user rows are never folded');

  // B237: a second fresh answer block supersedes the first; paragraphs of one
  // answer (continuation rows) and non-answer rows are untouched.
  const superseded = { rows: [{ id: 3, kind: 'assistant', text: 'first answer' }], version: 0 };
  renderBridge.foldSupersededAnswer(superseded);
  assert.equal(superseded.rows[0].progress, true);
  const paragraph = {
    rows: [{ id: 4, kind: 'assistant', text: 'second paragraph', continuation: true }],
    version: 0,
  };
  renderBridge.foldSupersededAnswer(paragraph);
  assert.equal(paragraph.rows[0].progress, undefined);
  const toolLast = { rows: [{ id: 5, kind: 'tool', text: 'Read(a.txt)' }], version: 0 };
  renderBridge.foldSupersededAnswer(toolLast);
  assert.equal(toolLast.rows[0].progress, undefined);

  const plan = toolSummary.summarizeToolCompletion(
    'exit_plan',
    {},
    'Append subtract() to sum.js and add a test; run node --test.',
    false
  );
  assert.equal(plan.dropBody, true);
  assert.match(plan.summary, /Plan submitted for approval/);
}
ok('pre-tool narration folds, and exit_plan does not reprint the plan');

// 5f. B221: one Chinese word for full mode, and its legacy aliases still parse.
{
  assert.equal(interactionMode.formatCliInteractionModeLabel('full', true), '完全访问');
  for (const token of ['full', '全开', '完全访问']) {
    assert.equal(interactionMode.parseCliInteractionMode(token), 'full', token);
  }
}
ok('full mode is 完全访问 in Chinese, and legacy 全开 still parses');

// 5g. B233: a non-zero exec exit reads as a failure and shows the error line.
{
  const failedBody = [
    'exit_code: 1',
    '',
    'node:internal/modules/cjs/loader:1478',
    '    throw err;',
    '    ^',
    '',
    "Error: Cannot find module '/tmp/x/missing-file.js'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1475:15)',
    '',
    '--- stderr ---',
    'same text again',
  ].join('\n');
  const failed = toolSummary.summarizeToolCompletion(
    'exec',
    { command: 'node missing-file.js' },
    failedBody,
    false
  );
  assert.equal(failed.summary, 'failed — exit 1');
  const lifted = toolSummary.liftExecFailureLine(failedBody).split('\n');
  assert.equal(lifted[0], 'exit_code: 1');
  assert.match(lifted[1], /^Error: Cannot find module/);
  assert.equal(
    lifted.filter((line) => line.startsWith('Error: Cannot find module')).length,
    1,
    'the error line is lifted, not duplicated'
  );
  const errorBody = [
    'Command failed (exit 1):',
    'node:internal/modules/cjs/loader:1478',
    '    throw err;',
    '',
    "Error: Cannot find module '/tmp/x/missing.js'",
    '    at Module._load (node:internal/modules/cjs/loader:1234:12)',
  ].join('\n');
  const errorSummary = toolSummary.summarizeToolCompletion(
    'exec',
    { command: 'node missing.js' },
    errorBody,
    true
  );
  assert.match(String(errorSummary.summary), /^failed — Error: Cannot find module/);
  const liftedError = toolSummary.liftExecFailureLine(errorBody).split('\n');
  assert.equal(liftedError[0], 'Command failed (exit 1):');
  assert.match(liftedError[1], /^Error: Cannot find module/);
}
ok('a non-zero exec exit reads as failed and lifts the error line');

// 5h. B234: recall is per workspace; the config-dir history is not merged.
{
  const sources = promptHistory.promptHistorySources('/tmp/project-a');
  assert.equal(sources.length, 1);
  assert.match(sources[0], /project-a[\\/]\.moss[\\/]prompt-history\.jsonl$/);
}
ok('prompt history is per workspace (no shared config-dir merge)');

// 5i. B237: the bridge folds the earlier of two fresh answer blocks (a model
// turn nudged into answering again must not print two full answers).
{
  const store = renderBridge.createTuiStore();
  if (typeof renderBridge.beginRun === 'function') renderBridge.beginRun(store, {});
  renderBridge.applyAgentEvent(store, { type: 'text_delta', delta: 'first answer\n\n' });
  renderBridge.applyAgentEvent(store, { type: 'turn_end' });
  renderBridge.applyAgentEvent(store, { type: 'text_delta', delta: 'second answer\n\n' });
  const answers = store.rows.filter((row) => row.kind === 'assistant');
  assert.equal(answers.length, 2);
  assert.equal(answers[0].progress, true, 'the superseded first answer folds');
  assert.equal(answers[1].progress, undefined, 'the latest answer stays full');
}
ok('two fresh answer blocks: the earlier one folds, the latest stays full');

// 5j. B249: a tool that repeats its headline as the body's first line drops it.
{
  assert.equal(
    renderBridge.dropDuplicatedLeadingLine(
      '[Sub-agent a] SUCCESS\nscope: read-only',
      '[Sub-agent a] SUCCESS'
    ),
    'scope: read-only'
  );
  assert.equal(
    renderBridge.dropDuplicatedLeadingLine('scope: read-only', '[Sub-agent a] SUCCESS'),
    'scope: read-only'
  );
  assert.equal(
    renderBridge.dropDuplicatedLeadingLine('[Sub-agent a] SUCCESSX\nrest', '[Sub-agent a] SUCCESS'),
    '[Sub-agent a] SUCCESSX\nrest'
  );
}
ok('a duplicated leading result line is dropped, not repeated under the headline');

// 5k. B256: the boot resume picker says it is loading instead of "no matching
// session" for its first frames.
{
  const loading = appHelpers
    .renderSessionPicker('', [], 0, 120, 8, { loading: true })
    .map((line) => line.text)
    .join('\n');
  assert.match(loading, /loading sessions/);
  assert.doesNotMatch(loading, /no matching session/);
  const empty = appHelpers
    .renderSessionPicker('', [], 0, 120, 8)
    .map((line) => line.text)
    .join('\n');
  assert.match(empty, /no matching session/);
}
ok('the resume picker shows a loading line, then the empty line');

// 5l. B257: an undo that dropped conversation turns says the scrollback above is
// stale (rows cannot be retracted from the terminal).
{
  const note = appHelpers.rewindScrollbackNote(3).join('\n');
  assert.match(note, /earlier turns stay as scrollback/);
  assert.deepEqual(appHelpers.rewindScrollbackNote(0), []);
  assert.deepEqual(appHelpers.rewindScrollbackNote(undefined), []);
}
ok('undo after dropping turns notes that the scrollback is no longer in context');

// 5m. B259: a folded narration line says how to expand; provider errors carry
// the endpoint/error code; a failed run says "failed", not "worked".
{
  const longNarration = {
    id: 41,
    kind: 'assistant',
    text: 'Authority: the locked test is the contract here. '.repeat(8),
    progress: true,
  };
  const foldedLong = transcript
    .renderTranscriptRow(longNarration, 80)
    .map((line) => line.text)
    .join('\n');
  assert.match(foldedLong, /ctrl\+o/, 'a truncated folded narration points at ctrl+o');
  const foldedShort = transcript
    .renderTranscriptRow({ id: 42, kind: 'assistant', text: 'short note', progress: true }, 80)
    .map((line) => line.text)
    .join('\n');
  assert.doesNotMatch(foldedShort, /ctrl\+o/);

  const raw = 'TypeError: fetch failed at https://api.example/v1 (cause ECONNREFUSED)';
  const suffix = renderBridge.errorDetailSuffix(raw, 'Could not connect. Check the base URL.');
  assert.match(suffix, /ECONNREFUSED/);
  assert.match(suffix, /https:\/\/api\.example\/v1/);
  assert.equal(
    renderBridge.errorDetailSuffix(raw, 'failed (ECONNREFUSED · https://api.example/v1)'),
    ''
  );
  assert.equal(renderBridge.errorDetailSuffix(undefined, 'x'), '');

  const failedSummary = transcript
    .renderRunSummary(1_000, false, 120, { input: 1, output: 1 }, new Date(), '', true)
    .map((line) => line.text)
    .join('\n');
  assert.match(failedSummary, /failed after 1s/);
  assert.doesNotMatch(failedSummary, /worked for/);
  const okSummary = transcript
    .renderRunSummary(1_000, false, 120, { input: 1, output: 1 }, new Date(), '')
    .map((line) => line.text)
    .join('\n');
  assert.match(okSummary, /worked for 1s/);
}
ok('folded narration, provider error details and failed-run summary are honest');

// 5n. B259 (network): a connection failure names the endpoint it tried.
{
  const store = renderBridge.createTuiStore();
  store.run.baseUrl = 'http://127.0.0.1:9/v1';
  renderBridge.applyAgentEvent(store, {
    type: 'error',
    error: 'fetch failed',
    retriable: true,
    errorSurface: {
      category: 'network',
      userMessage: 'Could not connect. Check the base URL and your network, then retry.',
      actions: [],
      silent: false,
      retryable: true,
    },
  });
  const errorRow = store.rows.find((row) => row.kind === 'error');
  assert.ok(errorRow, 'an error row is written');
  assert.match(errorRow.text, /http:\/\/127\.0\.0\.1:9\/v1/);
  assert.equal(store.run.lastError !== undefined, true);
}
ok('a network error row names the base URL and marks the run failed');

// 5o. B261: a narrow status bar shows the directory name, not a mid-truncated
// path; the Chinese full-mode label does not double up ("完全访问已开启").
{
  const narrow = transcript.renderStatusRight(
    {
      statusFields: statusLine.DEFAULT_STATUS_LINE_FIELDS,
      model: 'm',
      cwd: '/tmp/very/long/path/ux4-ws',
      tokensIn: 1_000,
      tokensOut: 20,
    },
    60
  ).text;
  assert.match(narrow, /ux4-ws/);
  assert.doesNotMatch(narrow, /…vate|very\/long/);
  const wide = transcript.renderStatusRight(
    {
      statusFields: statusLine.DEFAULT_STATUS_LINE_FIELDS,
      model: 'm',
      cwd: '/tmp/very/long/path/ux4-ws',
    },
    160
  ).text;
  assert.match(wide, /\/tmp\/very\/long\/path\/ux4-ws/);

  const copy = await load('dist/cli/tui/copy.js');
  copy.setTuiLocale(true);
  assert.equal(copy.tui('⏵⏵ {label} mode on', { label: '完全访问' }), '⏵⏵ 完全访问');
  copy.setTuiLocale(false);
}
ok('narrow status uses the directory name and the zh mode label is not doubled');

// 5p. B262: in a short terminal a result preview keeps one line (success) or
// two (failure), so the conversation still fits.
{
  const row = {
    id: 50,
    kind: 'result',
    text: 'a\nb\nc\nd\ne',
    tool: { name: 'run_tests', summary: 'passed' },
  };
  const normal = transcript.renderTranscriptRow(row, 80);
  const narrow = transcript.renderTranscriptRow(row, 80, false, undefined, true);
  assert.equal(normal.filter((line) => /^ {5}[a-e]$/.test(line.text)).length, 3);
  assert.equal(narrow.filter((line) => /^ {5}[a-e]$/.test(line.text)).length, 1);
  const failed = {
    id: 51,
    kind: 'result',
    text: 'a\nb\nc\nd\ne',
    tool: { name: 'run_tests', isError: true, summary: 'failed — boom' },
  };
  const narrowFailed = transcript.renderTranscriptRow(failed, 80, false, undefined, true);
  assert.equal(narrowFailed.filter((line) => /^ {5}[a-e]$/.test(line.text)).length, 2);
}
ok('a narrow terminal shortens result previews to 1/2 lines');

// 5q. B264: a resumed boot ends its replay with one confirmation line.
{
  const notice = appHelpers.resumeReplayNotice('cli-abc', 15);
  assert.match(notice, /resumed “cli-abc” — replayed 15 rows/);
  // B279: a known title is what makes the confirmation recognizable.
  const titled = appHelpers.resumeReplayNotice('cli-abc', 15, 'fix the flaky test');
  assert.match(titled, /resumed “fix the flaky test” — replayed 15 rows/);
  // B293: a single replay row is singular, not `row(s)`.
  const single = appHelpers.resumeReplayNotice('cli-abc', 1, 'one turn');
  assert.match(single, /replayed 1 row$/);
  assert.doesNotMatch(single, /row\(s\)/);
  const longTitle = appHelpers.resumeReplayNotice('cli-abc', 3, 'x'.repeat(80));
  assert.match(longTitle, /resumed “x{47}…” — replayed 3 rows/);
}
ok('a resumed replay ends with a resume confirmation');

// 5r. B273: a successful steer says "steered", not "queued".
{
  const steered = appHelpers.formatSteered('use ES modules');
  assert.match(steered, /^steered: use ES modules — applies at the next step$/);
}
ok('a successful steer is reported as steered, not queued');

// 5s. B292: the /agents footer pluralizes ("1 file agent", not "agent(s)").
{
  const agent = {
    id: 'auditor',
    description: 'Reviews changes',
    fileDefined: true,
    scope: 'project',
  };
  const one = agentFiles.formatFileAgentReport({ experts: [agent], zh: false });
  assert.match(one, /1 file agent$/m);
  assert.doesNotMatch(one, /agent\(s\)/);
  const two = agentFiles.formatFileAgentReport({
    experts: [agent, { ...agent, id: 'planner' }],
    zh: false,
  });
  assert.match(two, /2 file agents$/m);
}
ok('the agents panel pluralizes its footer');

// 5t. B294: the /permissions panel only explains workspace-write confinement
// when the mode actually derives it (not under full).
{
  const text = (modeKey, mode) =>
    permissionsPanel
      .renderPermissionsPanel({ width: 120, mode, modeKey, rules: [], cursor: 0 })
      .map((entry) => entry.text)
      .join('\n');
  const full = text('full', 'full');
  assert.doesNotMatch(full, /workspace-write confines/);
  assert.match(full, /no rules — full decides; deny still wins everywhere/);
  const plan = text('plan', 'plan');
  assert.match(plan, /workspace-write confines/);
  assert.match(plan, /no rules — plan decides/);
}
ok('the permissions panel explains confinement only when the mode derives it');

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
  const estimated = statusLine.formatStatusLine({
    model: 'm',
    cwd: '~/proj',
    tokensIn: 1_000,
    tokensOut: 10,
    contextPct: 2,
    contextEstimated: true,
  });
  assert.match(estimated, /ctx ~2%/, 'an unprobed window is shown as approximate');
  assert.doesNotMatch(
    statusLine.formatStatusLine({
      model: 'm',
      cwd: '~/proj',
      tokensIn: 1_000,
      tokensOut: 10,
      contextPct: 2,
    }),
    /ctx ~/
  );
  // B245: an idle bar does not print a meaningless ctx share.
  const idleCtx = transcript.renderStatusRight(
    {
      statusFields: statusLine.DEFAULT_STATUS_LINE_FIELDS,
      model: 'm',
      contextUsed: 0,
      contextTotal: 1_000_000,
    },
    160
  ).text;
  assert.doesNotMatch(idleCtx, /ctx/);
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
