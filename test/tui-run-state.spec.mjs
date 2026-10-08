#!/usr/bin/env node
/**
 * CLI shell run state: reasoning (`thinking_delta`) must never be merged into the
 * answer stream, and a run in flight must be visible — spinner, elapsed time,
 * token count — in the live region above the composer.
 *
 * It used to be merged, so the committed answer row (and therefore the panel
 * labelled "LAST EXCHANGE") showed the model's inner monologue as if it were the
 * reply. The loop's own bridge (cli/loop-tui-events.ts) treats thinking as
 * activity only; this keeps the shell consistent with it.
 *
 * Retargeted from the deleted Mission Control canvas to transcript.renderLive +
 * render-bridge.
 */
import assert from 'node:assert/strict';

import {
  applyAgentEvent,
  beginRun,
  createTuiStore,
  endRun,
  toTodos,
} from '../dist/cli/tui/render-bridge.js';
import {
  ANSWER_MARK,
  SPINNER_FRAMES,
  diffTone,
  renderLive,
  renderTodoPanel,
  renderRunSummary,
  renderStatusRight,
  renderTranscriptRow,
  spinnerFrame,
} from '../dist/cli/tui/transcript.js';

const text = (lines) => lines.map((entry) => entry.text).join('\n');

const THINKING = 'The user wants one word. ';

// ─── thinking stays out of the answer ─────────────────────────────────────

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, { type: 'thinking_delta', delta: THINKING });
  assert.equal(store.run.thinkingText, THINKING, 'reasoning is tracked');
  assert.equal(store.run.streamingText, '', 'reasoning is not the answer');

  applyAgentEvent(store, { type: 'text_delta', delta: 'pong' });
  assert.equal(store.run.streamingText, 'pong', 'answer stream holds only the answer');
  assert.ok(!store.run.streamingText.includes('one word'), 'the answer never absorbs reasoning');

  // Live region: reasoning is shown as dim activity (`· …`), never as an answer
  // row (`⏺ …`), so the two streams stay visually distinct while streaming.
  const live = renderLive(
    {
      running: true,
      startedAt: Date.now(),
      streaming: store.run.streamingText,
      thinking: store.run.thinkingText,
      tokensOut: 0,
      queued: 0,
    },
    80
  );
  const joined = text(live);
  assert.ok(joined.includes('pong'), 'answer visible while streaming');
  assert.ok(joined.includes('The user wants one word.'), 'reasoning visible while streaming');
  assert.ok(
    live.every((entry) => !entry.text.startsWith(ANSWER_MARK)),
    'live reasoning is never rendered as an answer row'
  );
  const reasoningLine = live.find((entry) => entry.text.includes('one word'));
  assert.ok(reasoningLine.text.startsWith('· '), 'reasoning rides the dim activity prefix');

  endRun(store, false);
  const last = store.rows[store.rows.length - 1];
  assert.equal(last.kind, 'assistant', 'the answer becomes an assistant row');
  assert.equal(last.text, 'pong', 'the answer row contains no reasoning');

  const committed = renderTranscriptRow(last, 80).map((entry) => entry.text);
  assert.ok(committed[1].startsWith(`${ANSWER_MARK} pong`), 'the committed answer keeps its mark');
  assert.ok(!committed.join('\n').includes('one word'), 'the committed answer has no reasoning');
}

// ─── a run in flight is visible in the live region ────────────────────────

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'c1',
    input: { command: 'fps_probe.sh' },
  });
  assert.ok(store.run.toolLine.includes('fps_probe.sh'), 'the in-flight tool is tracked');
  applyAgentEvent(store, { type: 'thinking_delta', delta: 'checking the pipeline' });
  applyAgentEvent(store, { type: 'text_delta', delta: 'measuring fps' });

  const lines = renderLive(
    {
      running: true,
      startedAt: Date.now() - 4200,
      toolLine: store.run.toolLine,
      streaming: store.run.streamingText,
      thinking: store.run.thinkingText,
      tokensOut: 1500,
      queued: 1,
    },
    80
  );
  const joined = text(lines);
  assert.match(joined, /[✢✳✶✻✽] \w+… 4s/, 'spinner + elapsed seconds are shown');
  assert.ok(joined.includes('1.5k out'), 'current run output tokens are labeled');
  assert.ok(joined.includes('1 queued'), 'queued submissions are shown');
  assert.ok(
    !joined.includes('fps_probe.sh'),
    'live region does not duplicate the transcript tool row'
  );
  assert.equal(
    store.rows.filter((row) => row.kind === 'tool' && row.text.includes('fps_probe.sh')).length,
    1,
    'the tool is recorded once in the transcript'
  );
  assert.ok(joined.includes('checking the pipeline'), 'reasoning is shown dimmed');
  assert.ok(joined.includes('measuring fps'), 'answer preview is shown');
  assert.ok(!joined.includes('Try "'), 'the composer placeholder is not part of the live region');

  // The spinner actually animates: different elapsed times pick different frames,
  // and the cycle wraps instead of running off the table.
  assert.notEqual(spinnerFrame(0), spinnerFrame(240), 'the spinner frame advances');
  assert.equal(spinnerFrame(0), spinnerFrame(120 * SPINNER_FRAMES.length), 'the spinner wraps');
  assert.ok(SPINNER_FRAMES.includes(spinnerFrame(0)), 'frames come from the table');
}

// ─── an idle or blocked shell must not pretend to be working ──────────────

{
  const idle = renderLive(
    { running: false, streaming: 'leftover', thinking: 'leftover', tokensOut: 9, queued: 0 },
    80
  );
  assert.deepEqual(idle, [], 'no live region when no run is in flight');

  const blocked = renderLive(
    {
      running: true,
      startedAt: Date.now() - 3000,
      toolLine: 'Write(a.txt)',
      streaming: 'streaming text',
      thinking: 'reasoning text',
      tokensOut: 10,
      queued: 0,
      blocked: true,
    },
    80
  );
  const joined = text(blocked);
  assert.ok(joined.includes('streaming text'), 'a blocked run still shows what it produced');
  assert.ok(
    !/[✢✳✶✻✽] \w+…/.test(joined),
    'a run waiting on approval shows no spinner — the activity line would lie'
  );
}

// ─── a finished run leaves an honest summary ──────────────────────────────

{
  assert.match(
    text(renderRunSummary(5000, false, 80)),
    /^\n✻ worked for 5s · done \d{1,2}:\d{2}/,
    'summary line carries the local finish time'
  );
  assert.match(
    text(
      renderRunSummary(5000, false, 80, { input: 0, output: 0 }, new Date('2026-10-01T09:05:00'))
    ),
    /✻ worked for 5s · done/,
    'the wall-clock stamp is injectable for deterministic asserts'
  );
  assert.match(
    text(renderRunSummary(5000, true, 80)),
    /✻ \w+ for 5s · interrupted/,
    'a halted run says so'
  );
}

// ─── context window + compaction reach the status line ───────────────────

{
  const store = createTuiStore();
  applyAgentEvent(store, {
    type: 'llm_usage',
    inputTokens: 40_000,
    outputTokens: 100,
    cacheReadTokens: 10_000,
    cacheCreationTokens: 0,
    contextTokens: 200_000,
    model: 'provider-routed-model',
  });
  assert.equal(store.usage.contextTotal, 200_000, 'the context window is recorded');
  assert.equal(store.usage.contextUsed, 50_000, 'prompt tokens include cache reads');
  assert.equal(store.usage.lastModel, 'provider-routed-model', 'actual provider model is recorded');

  const status = renderStatusRight(
    {
      running: false,
      model: 'model-x',
      tokens: 1500,
      taskCount: 0,
      queueLength: 0,
      contextUsed: 180_000,
      contextTotal: 200_000,
    },
    80
  );
  assert.ok(status.text.includes('90% ctx'), 'the status line shows how full the context is');
  assert.ok(!status.text.includes('tokens'), 'idle status does not duplicate the usage ledger');

  applyAgentEvent(store, { type: 'compaction', droppedMessages: 12, tokensAfter: 8000 });
  const last = store.rows[store.rows.length - 1];
  assert.equal(last.kind, 'summary', 'compaction is announced in the transcript');
  assert.ok(last.text.includes('12 earlier messages'), 'the notice says what was dropped');
  assert.equal(store.usage.compactions, 1, 'compactions are counted');
}

// ─── edit diffs are coloured in the transcript ───────────────────────────

{
  assert.deepEqual(diffTone('+ added'), { color: 'green' }, 'an added line is green');
  assert.deepEqual(diffTone('- removed'), { color: 'red' }, 'a removed line is red');
  assert.deepEqual(diffTone('@@ hunk'), { color: 'cyan', dim: true }, 'a hunk header is quiet');
  assert.deepEqual(diffTone('context'), { dim: true }, 'context stays dim');

  const rows = renderTranscriptRow({ id: 1, kind: 'result', text: '+ a\n- b\n plain' }, 60);
  const coloured = rows.filter((line) => line.color);
  assert.equal(coloured.length, 2, 'both diff signs are coloured');
  assert.equal(coloured[0].color, 'green', 'added line green in the transcript');
  assert.equal(coloured[1].color, 'red', 'removed line red in the transcript');
}

// ─── live todo checklist ─────────────────────────────────────────────────

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'todo_write',
    toolCallId: 't1',
    input: {
      todos: [
        { content: 'audit the shell', status: 'completed' },
        { content: 'add the palette', status: 'in_progress' },
        { content: 'run verify', status: 'pending' },
      ],
    },
  });
  assert.equal(store.todos.length, 3, 'the checklist is captured from the tool call');

  const panel = renderTodoPanel(store.todos, 60);
  const text = panel.map((line) => line.text).join('\n');
  assert.ok(text.includes('1/3 done'), 'the header counts progress');
  assert.ok(text.includes('✓ audit the shell'), 'completed items carry a check');
  assert.ok(text.includes('◐ add the palette'), 'the in-flight item is marked');
  assert.ok(text.includes('○ run verify'), 'pending items are marked');
  assert.equal(panel[2].bold, true, 'only the in-flight row is emphasised');
  for (const line of renderTodoPanel(store.todos, 24)) {
    assert.ok(line.text.length <= 24, 'the panel fits the pane');
  }

  // Defensive parsing: junk in, no crash, nothing invented.
  assert.deepEqual(toTodos([null, 5, { status: 'x' }, { content: '  ' }]), [], 'junk is dropped');
  assert.deepEqual(
    toTodos([{ content: ' keep me ', status: 'pending' }]),
    [{ content: 'keep me', status: 'pending' }],
    'content is trimmed and status defaults'
  );
  assert.deepEqual(renderTodoPanel([], 40), [], 'no todos, no panel');

  // A failed todo_write must NOT read as progress: the result row carries the
  // failure summary instead of a "N/M done" count.
  const failed = createTuiStore();
  beginRun(failed);
  applyAgentEvent(failed, {
    type: 'tool_start',
    toolName: 'todo_write',
    toolCallId: 't2',
    input: { todos: [{ content: 'step', status: 'in_progress' }] },
  });
  applyAgentEvent(failed, {
    type: 'tool_end',
    toolName: 'todo_write',
    toolCallId: 't2',
    isError: true,
    result: 'checklist rejected',
  });
  const failedRow = failed.rows.find((row) => row.kind === 'result');
  assert.ok(failedRow?.tool?.isError, 'the failed todo_write row is marked as an error');
  assert.doesNotMatch(failedRow?.tool?.summary ?? '', /done$/, 'no progress count on failure');
}

console.log('OK tui-run-state');
