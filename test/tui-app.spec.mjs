#!/usr/bin/env node
/**
 * moss CLI shell (v0.22): single-column transcript, bracketed paste, Esc
 * interrupt, resume replay. Component-level via ink-testing-library; pure
 * modules (paste capture, render bridge, transcript window) directly.
 *
 * Retargeted from the deleted full-screen transcript/status-bar modules to the
 * render-bridge rows + transcript projections the shell actually renders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createPasteCapture,
  feedChunk,
  confirmPendingPaste,
  PASTE_START,
  PASTE_END,
} from '../dist/cli/tui/input-box.js';
import {
  applyAgentEvent,
  appendRow,
  beginRun,
  createTuiStore,
  endRun,
  formatUsage,
  usageBlock,
  visibleRows,
} from '../dist/cli/tui/render-bridge.js';
import {
  renderHint,
  renderLive,
  renderRunSummary,
  renderStatusRight,
  renderTranscriptRows,
} from '../dist/cli/tui/transcript.js';
import { TuiAppRoot, questionDialogFromPrompt, runTuiApp } from '../dist/cli/tui/app.js';
import { buildResumeReplay } from '../dist/cli/tui-utils.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const parsed = questionDialogFromPrompt(
    'Choose a build profile.\n  1. C++ — use the existing ABI — recommended\n  2. Rust\nEnter a number, or free text for "Other".'
  );
  assert.ok(parsed, 'question prompt with long-dash labels is parsed');
  assert.deepEqual(
    parsed.answers,
    ['C++ — use the existing ABI — recommended', 'Rust'],
    'question answers preserve the complete option labels'
  );
}

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000, stepMs = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ─── 1. Bracketed paste: 50 lines become ONE pending message ────────────────

{
  const cap = createPasteCapture();
  const lines = Array.from({ length: 50 }, (_, i) => `pasted line ${i + 1}`);
  const paste = `${PASTE_START}${lines.join('\n')}${PASTE_END}`;
  // Terminals may deliver the paste in several chunks.
  const mid = Math.floor(paste.length / 3);
  const d1 = feedChunk(cap, paste.slice(0, mid));
  const d2 = feedChunk(cap, paste.slice(mid, mid * 2));
  const d3 = feedChunk(cap, paste.slice(mid * 2));
  assert.equal(d1.completed || d2.completed || d3.completed, true, 'paste completes');
  const pending = confirmPendingPaste(cap);
  assert.ok(pending, 'one pending message captured');
  assert.equal(pending.split('\n').length, 50, 'all 50 lines in ONE message');
  assert.equal(confirmPendingPaste(cap), undefined, 'nothing else queued — exactly one turn');

  const noPaste = feedChunk(createPasteCapture(), 'regular typing');
  assert.equal(noPaste.consumed, false, 'normal typing is not hijacked');
}

// ─── 2. Render bridge: events → transcript rows ─────────────────────────────

{
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, { type: 'text_delta', delta: 'hello ' });
  applyAgentEvent(store, { type: 'text_delta', delta: 'world' });
  applyAgentEvent(store, { type: 'tool_start', toolName: 'exec', toolCallId: 't1', input: {} });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 't1',
    result: 'ok',
    isError: false,
  });
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'write_file',
    toolCallId: 't2',
    input: { file_path: 'a.txt' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'write_file',
    toolCallId: 't2',
    result: 'line1\nline2\nline3\nline4\nline5',
    isError: false,
  });
  applyAgentEvent(store, { type: 'tool_start', toolName: 'exec', toolCallId: 't3', input: {} });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 't3',
    result: 'boom',
    isError: true,
  });
  applyAgentEvent(store, { type: 'error', error: 'explode', retriable: false });
  endRun(store, false);

  const kinds = store.rows.map((r) => r.kind);
  // A tool call is transcript content (`⏺ Write(a.txt)`), its result is a `⎿`
  // row, and the streaming tail commits as an assistant row at endRun.
  assert.deepEqual(
    kinds,
    ['tool', 'result', 'tool', 'result', 'tool', 'result', 'error', 'assistant'],
    JSON.stringify(kinds)
  );
  // A call with no usable argument gets a bare label: `Exec(running )` was empty
  // parens carrying no information. `Write(a.txt)` below covers the arg case.
  assert.equal(
    store.rows[0].text,
    'Exec',
    'tool_start with no argument is a bare Claude-style label'
  );
  assert.equal(store.rows[1].text, 'ok', 'tool_end becomes a result row');
  assert.equal(store.rows[2].text, 'Write(a.txt)', 'the tool label names the file it touches');
  // The ROW keeps the whole result (the verbose view must be able to reveal it);
  // the COMPACT projection is what caps the preview at 3 lines.
  assert.equal(
    store.rows[3].text,
    'line1\nline2\nline3\nline4\nline5',
    'the result row keeps the full output'
  );
  const compactResult = renderTranscriptRows([store.rows[3]], 40).map((l) => l.text);
  assert.ok(
    compactResult.some((text) => text.includes('line3')),
    'the compact projection shows the head of the result'
  );
  assert.ok(
    !compactResult.some((text) => text.includes('line5')),
    'the compact projection hides the tail behind the ctrl+o marker'
  );
  assert.equal(store.rows[5].text, 'boom', 'the failed row keeps the raw result text');
  assert.equal(store.rows[5].tool?.isError, true, 'the failure is meta, not a text prefix');
  assert.match(
    store.rows[5].tool?.summary ?? '',
    /failed — boom/,
    'the red headline carries the failure detail'
  );
  assert.equal(store.rows[6].text, 'explode', 'errors surface their message verbatim');
  assert.equal(store.rows[7].text, 'hello world', 'the answer commits as an assistant row');
  assert.equal(store.run.running, false);
  assert.equal(store.run.toolLine, undefined, 'the in-flight tool clears when it finishes');
}

// ─── 2b. Tool completion meta: summaries, durations, diffs, retries ─────────

{
  const store = createTuiStore();
  beginRun(store);
  // A write with content: the transcript shows the gain summary + the diff gutter.
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'write_file',
    toolCallId: 'w1',
    input: { path: 'notes.md', content: '# title\n\nbody text\n' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'write_file',
    toolCallId: 'w1',
    result: 'Wrote 3 lines to notes.md',
    isError: false,
    durationMs: 320,
  });
  const writeRow = store.rows.at(-1);
  assert.equal(writeRow.tool?.summary, 'Wrote 3 lines', 'the headline counts the written lines');
  assert.equal(writeRow.tool?.durationMs, 320, 'the call duration is kept');
  assert.ok(writeRow.text.includes('+ # title'), 'the row body is the new-file diff');
  const writeLines = renderTranscriptRows([writeRow], 72).map((l) => l.text);
  assert.ok(
    writeLines.some((text) => text.includes('⎿') && text.includes('Wrote 3 lines')),
    `the ⎿ headline leads the block: ${JSON.stringify(writeLines)}`
  );
  assert.ok(
    writeLines.some((text) => text.includes('320ms')),
    'the duration rides the headline'
  );

  // An edit: Added/removed counts + a real diff gutter.
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'edit_file',
    toolCallId: 'e1',
    input: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 1;\nconst b = 2;' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'edit_file',
    toolCallId: 'e1',
    result: 'edited a.ts',
    isError: false,
    durationMs: 5200,
  });
  const editRow = store.rows.at(-1);
  assert.match(editRow.tool?.summary ?? '', /Added 1 line/, 'the edit summary counts gains');
  const editLines = renderTranscriptRows([editRow], 72);
  const durationLine = editLines.find((l) => l.text.includes('5.2s'));
  assert.ok(durationLine, 'a slow tool shows its duration');
  assert.ok(
    durationLine.runs?.some((r) => r.color === 'yellow'),
    'a >3s call turns the duration yellow'
  );
  assert.ok(
    editLines.some((l) => l.color === 'green' && l.text.includes('const b = 2;')),
    'the added line renders green in the gutter'
  );

  // A ranged read names its window; a long exec surfaces its tail.
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'r1',
    input: { path: 'big.ts', offset: 10, limit: 30 },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'read_file',
    toolCallId: 'r1',
    result: '[lines 10-39 of 200]\n' + '   10\tcode\n'.repeat(30),
    isError: false,
  });
  assert.equal(store.rows.at(-1).tool?.summary, 'Read lines 10-39 of 200');

  const longOutput =
    Array.from({ length: 30 }, (_, i) => `build step ${i}`).join('\n') + '\nBuild completed in 12s';
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'x1',
    input: { command: 'npm run build' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'x1',
    result: longOutput,
    isError: false,
  });
  assert.match(
    store.rows.at(-1).tool?.summary ?? '',
    /Build completed in 12s/,
    'a long command surfaces its conclusion, not its head'
  );

  // A short exec result that fits the preview gets NO headline (no double-telling).
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'x2',
    input: { command: 'pwd' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'x2',
    result: '/tmp',
    isError: false,
    durationMs: 41,
  });
  const shortRow = store.rows.at(-1);
  assert.equal(shortRow.tool?.summary, undefined, 'short output needs no summary');
  const shortLines = renderTranscriptRows([shortRow], 72).map((l) => l.text);
  assert.ok(
    shortLines.some((text) => text.includes('⎿') && text.includes('41ms')),
    'the duration still shows'
  );

  // Provider retries land in the live state, and progress clears them.
  applyAgentEvent(store, { type: 'retry', attempt: 2, error: 'rate limited' });
  assert.deepEqual(store.run.retry, { attempt: 2, error: 'rate limited' });
  assert.match(
    store.rows.at(-1).text,
    /↻ provider retry 2 — rate limited/,
    'a retry leaves a transcript marker so regenerated text reads as a retry'
  );
  applyAgentEvent(store, { type: 'text_delta', delta: 'ok' });
  assert.equal(store.run.retry, undefined, 'progress clears the retry notice');

  // ask_user_question: the dialog already showed each answer; the synthetic
  // "User has answered your questions: …" wrapper must not dump them again.
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'ask_user_question',
    toolCallId: 'q1',
    input: {},
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'ask_user_question',
    toolCallId: 'q1',
    isError: false,
    result:
      'User has answered your questions: "代码放在哪里？"="放进已有的 cpp-demo/". ' +
      "You can now continue with the user's answers in mind.",
    durationMs: 8000,
  });
  const questionRow = store.rows.at(-1);
  assert.equal(questionRow.tool?.summary, 'answered');
  assert.equal(questionRow.text, '', 'the wrapper body is dropped');

  // An exec tail that is only the program's own `exit=0` line is noise: the
  // summary must reach past it to the real conclusion.
  const noisyTail = `${Array.from({ length: 30 }, (_, i) => `step ${i}`).join('\n')}\nexit=0`;
  applyAgentEvent(store, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'x3',
    input: { command: './build.sh; echo exit=$?' },
  });
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'x3',
    result: noisyTail,
    isError: false,
  });
  assert.equal(
    store.rows.at(-1).tool?.summary,
    'step 29',
    'the tail summary skips a bare exit= line'
  );

  // A classified provider failure renders its sanitized surface (user message
  // + suggested actions) instead of the raw error string.
  applyAgentEvent(store, {
    type: 'error',
    error: 'PiAiFirstEventTimeoutError: raw internals',
    retriable: true,
    errorSurface: {
      category: 'timeout',
      userMessage: '模型响应超时，请稍后重试。',
      actions: [
        { id: 'retry', label: '重试', variant: 'primary' },
        { id: 'switchModel', label: '换一个模型', variant: 'secondary' },
      ],
      silent: false,
      retryable: true,
    },
  });
  assert.equal(
    store.rows.at(-1).text,
    '模型响应超时，请稍后重试。 (重试 · 换一个模型)',
    'the error row carries the human reading and the actions'
  );

  // Microcompaction is announced, not silent.
  applyAgentEvent(store, {
    type: 'microcompact',
    compressedCount: 4,
    savedChars: 9000,
    savedTokens: 2400,
  });
  assert.match(
    store.rows.at(-1).text,
    /compressed 4 old tool results · saved ~2.4k tokens/,
    'microcompact leaves a transcript note'
  );

  // Prompt-cache hits accumulate into the usage line.
  applyAgentEvent(store, {
    type: 'llm_usage',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 4000,
    generationMs: 2500,
    ttftMs: 800,
  });
  assert.equal(store.usage.cacheReadTokens, 4000);
  assert.match(formatUsage(store.usage), /4k prompt-cache hits/, 'cache hits are visible');

  // The /usage block accounts for time, runs and (configured) cost.
  endRun(store, false);
  endRun(store, false);
  const block = usageBlock(store.usage, { MOSS_PRICE_IN: '1', MOSS_PRICE_OUT: '2' });
  assert.match(block[0], /tokens\s+/, 'the token split leads');
  assert.match(
    block[1],
    /runs\s+2 · api 2.5s · avg first-token 800ms/,
    'runs, api time and first-token latency are accounted'
  );
  assert.match(block[2], /\$0\.0041/, 'cost is computed from the configured per-1M prices');
  const unpriced = usageBlock(store.usage, {});
  assert.match(
    unpriced[2],
    /unknown — set MOSS_PRICE_IN/,
    'without pricing the line says unknown instead of guessing'
  );
  endRun(store, false);
}

// ─── 2c. Run summary tokens + context high-water status ─────────────────────

{
  const done = renderRunSummary(12_000, false, 200, { input: 3200, output: 891 })
    .map((l) => l.text)
    .join('\n');
  assert.match(done, /✻ \w+ for 12s · done /, 'the run summary is human-sized: time + finish');
  assert.ok(!done.includes('prompt'), 'token telemetry stays in /usage, not the run line');
  const halted = renderRunSummary(4000, true, 200, { input: 0, output: 0 })
    .map((l) => l.text)
    .join('\n');
  assert.match(halted, /· interrupted$/, 'halted runs say interrupted');
  assert.ok(!renderRunSummary(4000, false, 200).some((l) => l.text.includes('↑')));
  assert.match(
    renderRunSummary(4000, false, 200, undefined, new Date('2026-10-01T23:45:00'))
      .map((l) => l.text)
      .join('\n'),
    /· done /,
    'the summary carries the local finish time'
  );

  const hot = renderStatusRight(
    {
      running: false,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      contextUsed: 87_000,
      contextTotal: 100_000,
    },
    80
  );
  assert.ok(hot.text.includes('87% ctx'), 'the percentage is shown');
  assert.ok(
    hot.runs?.some((r) => r.color === 'yellow' && r.text === '87% ctx'),
    'past 80% the segment turns yellow'
  );
  const critical = renderStatusRight(
    {
      running: false,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      contextUsed: 97_000,
      contextTotal: 100_000,
    },
    80
  );
  assert.ok(
    critical.runs?.some((r) => r.color === 'red'),
    'past 95% the segment turns red'
  );
  const cool = renderStatusRight(
    {
      running: false,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      contextUsed: 10_000,
      contextTotal: 100_000,
    },
    80
  );
  assert.equal(cool.runs, undefined, 'a cool context keeps the plain dim row');
}

// ─── 2d. Live region: markdown tail, stall flag ─────────────────────────────

{
  // The streaming tail stays stable plain text; committed answers are projected
  // through markdown after the turn, so incomplete tables do not reflow live.
  const md = renderLive(
    {
      running: true,
      startedAt: Date.now() - 5000,
      streaming: 'Results:\n\n| Case | Verdict |\n|---|---|\n| build | pass |',
      thinking: '',
      tokensOut: 0,
      queued: 0,
    },
    60
  );
  assert.ok(
    md.some((l) => l.text.includes('|---|')),
    'the live region keeps incomplete markdown source stable'
  );
  assert.ok(
    md.some((l) => l.text.includes('Case') && l.text.includes('Verdict')),
    'the table content renders live'
  );

  // A stream that has gone quiet past the hint threshold says so; an active
  // stream does not.
  const stalled = renderLive(
    {
      running: true,
      startedAt: Date.now() - 60_000,
      streaming: '',
      thinking: '',
      tokensOut: 0,
      queued: 0,
      lastEventAt: Date.now() - 30_000,
    },
    80
  );
  assert.ok(
    stalled.some((l) => /stream quiet for \d+s/.test(l.text)),
    'a quiet stream is flagged'
  );
  const fresh = renderLive(
    {
      running: true,
      startedAt: Date.now() - 5000,
      streaming: '',
      thinking: '',
      tokensOut: 0,
      queued: 0,
      lastEventAt: Date.now(),
    },
    80
  );
  assert.ok(!fresh.some((l) => l.text.includes('stream quiet')), 'an active stream is not flagged');
}

// ─── 2e. The session-event recorder logs retries and failures ───────────────

{
  const { SessionEventLog } = await import('../dist/core/session/session-event.js');
  const { recordAgentEvent } = await import('../dist/core/session/session-event-recorder.js');
  const log = new SessionEventLog('spec-session');
  recordAgentEvent(log, { type: 'retry', attempt: 3, error: 'rate limited' });
  recordAgentEvent(log, { type: 'error', error: 'stream stalled' });
  const events = log.all().map((event) => ({ type: event.type, data: event.data }));
  assert.deepEqual(
    events[0],
    { type: 'step.retry', data: { attempt: 3, error: 'rate limited' } },
    'a provider retry is a first-class log event (regenerated answers get explained)'
  );
  assert.deepEqual(
    events[1],
    { type: 'step.failed', data: { message: 'stream stalled' } },
    'an error keeps its message in the log'
  );
}

// ─── 3. Status/hint chrome + transcript window ──────────────────────────────

{
  const status = renderStatusRight(
    { running: true, model: 'deepseek-flash@latest', tokens: 1500, taskCount: 0, queueLength: 0 },
    80
  ).text;
  assert.match(status, /● running/, 'a live run is announced in the status line');
  assert.match(status, /deepseek-flash@latest/, 'the active model is shown');
  assert.doesNotMatch(status, /tokens/, 'idle status leaves token accounting to /usage');
  assert.match(
    renderStatusRight({ running: true, blocked: true, tokens: 0, taskCount: 0, queueLength: 0 }, 80)
      .text,
    /● waiting for you/,
    'an approval wait is announced, not hidden behind the spinner'
  );
  assert.match(
    renderHint({ running: true, tokens: 0, taskCount: 0, queueLength: 0 }, 80).text,
    /Esc to interrupt/,
    'a live run advertises how to stop it'
  );
  assert.match(
    renderHint(
      {
        running: true,
        blocked: true,
        dialogKind: 'question',
        dialogHasOptions: false,
        tokens: 0,
        taskCount: 0,
        queueLength: 0,
        // v0.26: the factory-default mode is full (no cycle suffix, short hint);
        // a cycled manual mode would lengthen the row and clip the answer hint
        // at this width.
        mode: 'full',
      },
      80
    ).text,
    /type answer · Enter to send/,
    'a free-text question advertises text input instead of numeric approval keys'
  );

  const store = createTuiStore();
  for (let i = 1; i <= 30; i++) {
    appendRow(store, 'user', `row ${i}`);
  }
  assert.deepEqual(
    visibleRows(store, 5, 0).map((r) => r.text),
    ['row 26', 'row 27', 'row 28', 'row 29', 'row 30'],
    'the transcript window shows the newest rows'
  );
  assert.ok(
    visibleRows(store, 5, 10)[0].text.includes('row 16'),
    'scrolling back moves the window without re-projecting the whole history'
  );
  const rendered = renderTranscriptRows(visibleRows(store, 5, 0), 40).map((l) => l.text);
  assert.ok(rendered.includes('❯ row 30'), 'windowed rows render in the transcript grammar');
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(20);
  }
  instance.stdin.write('\r');
  await sleep(20);
}

// ─── 4. Component: help, paste→one call, Esc interrupt, resume replay ───────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');

  const calls = [];
  function createMockAgent({ slow = false } = {}) {
    return {
      async *streamChat(sessionKey, message, opts) {
        calls.push({ sessionKey, message, aborted: false });
        const callIndex = calls.length - 1;
        for (let i = 0; i < (slow ? 10 : 1); i++) {
          if (slow && opts?.abortSignal?.aborted) {
            calls[callIndex].aborted = true;
            return;
          }
          yield { type: 'text_delta', delta: `echo: ${message.slice(0, 20)} [${i}] ` };
          if (slow) await sleep(60);
        }
        yield {
          type: 'done',
          result: { response: `echo: ${message.slice(0, 30)}`, stopReason: 'end_turn' },
        };
      },
    };
  }

  function mount(options) {
    const handle = liveHandle();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-app-'));
    const runtime = new TaskRuntime({ workspaceDir: workspace });
    const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
    return { instance, handle, runtime, workspace };
  }

  // 4a. /help prints the key + command reference into the transcript
  {
    calls.length = 0;
    const { instance } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      model: 'm-test',
    });
    await type(instance, '/help');
    const ok = await waitFor(() => instance.lastFrame().includes('Help · Esc or Enter to close'));
    assert.ok(ok, `help overlay visible: ${JSON.stringify(instance.lastFrame().slice(0, 200))}`);
    assert.ok(instance.lastFrame().includes('interrupt the run'), 'shortcut help is visible');
    instance.unmount();
    await sleep(150);
  }

  // 4b. A 50-line paste is confirmed into exactly ONE agent call; the response
  // lands in the transcript, where the user can scroll back to it.
  {
    calls.length = 0;
    const { instance, handle } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    instance.stdin.write(`${PASTE_START}${lines.join('\n')}${PASTE_END}`);
    await waitFor(() => instance.lastFrame().includes('Pasted text #1'));
    instance.stdin.write(' tail');
    await waitFor(() => instance.lastFrame().includes('tail'));
    instance.stdin.write('\r');
    const ok = await waitFor(() => calls.length === 1);
    assert.ok(ok, `exactly one streamChat call (got ${calls.length})`);
    assert.equal(calls[0].message.split('\n').length, 50, 'full paste in one message');
    await waitFor(() => handle.store.run.running === false);
    const visible = await waitFor(() => instance.lastFrame().includes('echo:'));
    assert.ok(visible, 'the response is committed to the transcript');
    instance.unmount();
    await sleep(150);
  }

  // 4c. Esc interrupts a running turn at a boundary; process survives.
  // Isolated subprocess: sequential ink instances in one process leak state.
  {
    const r = spawnSync(process.execPath, ['test/fixtures/tui-esc-case.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `esc case failed: ${(r.stderr || r.stdout || '').slice(-300)}`);
    assert.match(r.stdout, /TUI-ESC-OK/);
  }

  // 4d. Resume replay rows render on boot via runTuiApp options (the transcript
  // is the conversation, so no panel has to be opened to see it).
  {
    const replay = buildResumeReplay([
      { role: 'user', content: 'earlier question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'earlier answer' },
          { type: 'tool_use', name: 'exec', input: { command: 'ls' } },
        ],
      },
    ]);
    const replayRows = replay.items.map((item) => ({ kind: item.kind, text: item.text }));
    const { instance } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      replayRows,
    });
    const ok = await waitFor(
      () =>
        instance.lastFrame().includes('earlier question') &&
        instance.lastFrame().includes('earlier answer')
    );
    assert.ok(ok, `replay rendered: ${instance.lastFrame().slice(0, 200)}`);
    assert.ok(
      !instance.lastFrame().includes('resumed — replayed'),
      'the replay lands without a trailing summary row'
    );
    instance.unmount();
    await sleep(150);
  }

  // 4e. Unknown slash commands answer honestly
  {
    calls.length = 0;
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    await type(instance, '/nope');
    const ok = await waitFor(() => instance.lastFrame().includes('unknown command "/nope"'));
    assert.ok(ok, `unknown command answered: ${instance.lastFrame().slice(0, 200)}`);
    instance.unmount();
    await sleep(150);
  }

  // 4f. Composer editing keys: Ctrl+A/E caret, Ctrl+U kill + Ctrl+Y yank.
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    for (const ch of 'abc') instance.stdin.write(ch);
    await sleep(60);
    instance.stdin.write('\x01'); // Ctrl+A → line start
    await sleep(40);
    instance.stdin.write('X');
    await sleep(40);
    instance.stdin.write('\x05'); // Ctrl+E → line end (NOT the evidence panel)
    await sleep(40);
    instance.stdin.write('Y');
    await sleep(60);
    assert.ok(
      instance.lastFrame().includes('XabcY'),
      `Ctrl+A/E move the caret for mid-line edits: ${JSON.stringify(instance.lastFrame())}`
    );
    instance.stdin.write('\x15'); // Ctrl+U → kill to line start
    await sleep(60);
    assert.ok(
      instance.lastFrame().includes('Ctrl+Y to paste back'),
      'a kill advertises its undo key'
    );
    assert.ok(
      !instance
        .lastFrame()
        .split('\n')
        .some((row) => row.startsWith('❯ XabcY')),
      'the composer row no longer holds the killed draft'
    );
    instance.stdin.write('\x19'); // Ctrl+Y → yank
    await sleep(60);
    assert.ok(instance.lastFrame().includes('XabcY'), 'Ctrl+Y pastes the killed text back');
    instance.unmount();
    await sleep(150);
  }

  // 4g. Esc on an idle draft arms "Esc again to clear"; the second Esc clears.
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    for (const ch of 'draft text') instance.stdin.write(ch);
    await sleep(60);
    instance.stdin.write('\x1b');
    await sleep(60);
    assert.ok(
      instance.lastFrame().includes('Esc again to clear'),
      'the first Esc arms instead of destroying the draft'
    );
    assert.ok(instance.lastFrame().includes('draft text'), 'the draft survives one Esc');
    instance.stdin.write('\x1b');
    await sleep(60);
    assert.ok(!instance.lastFrame().includes('draft text'), 'the second Esc clears');
    instance.unmount();
    await sleep(150);
  }

  // 4h. /evidence prints the evidence block.
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    await type(instance, '/evidence');
    const ok = await waitFor(() => instance.lastFrame().includes('Evidence'));
    assert.ok(ok, `/evidence prints evidence: ${instance.lastFrame().slice(0, 160)}`);
    instance.unmount();
    await sleep(150);
  }

  // 4i. /clear wipes the visible transcript but keeps the banner and says so.
  {
    const { instance, handle } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      model: 'm-test',
    });
    await type(instance, '/help');
    await waitFor(() => instance.lastFrame().includes('Help · Esc or Enter to close'));
    instance.stdin.write('\x1b');
    await waitFor(() => !instance.lastFrame().includes('Help · Esc or Enter to close'));
    await type(instance, '/clear');
    const ok = await waitFor(() => instance.lastFrame().includes('transcript cleared'));
    assert.ok(ok, `/clear reports itself: ${instance.lastFrame().slice(0, 200)}`);
    assert.ok(
      handle.store.rows.every((row) => row.kind === 'banner' || row.kind === 'summary'),
      'only the banner and the clear note survive'
    );
    instance.unmount();
    await sleep(150);
  }

  // 4j. A provider retry splits the two generations at a visible boundary:
  // the stalled call's partial text commits as its own row, the retry marker
  // sits between them, and the regenerated text never concatenates onto the
  // partial (which is how duplicated paragraphs used to appear mid-answer).
  {
    const retryAgent = {
      async *streamChat() {
        yield { type: 'text_delta', delta: 'partial answer that stalled' };
        yield { type: 'retry', attempt: 1, error: 'stream stalled' };
        yield { type: 'text_delta', delta: 'regenerated answer' };
        yield {
          type: 'done',
          result: { response: 'regenerated answer', stopReason: 'end_turn' },
        };
      },
    };
    const { instance, handle } = mount({ agent: retryAgent, workspaceDir: '/tmp/ws' });
    await type(instance, 'go');
    const finished = await waitFor(() => handle.store.run.running === false);
    assert.ok(finished, 'the retried run completes');
    const rows = handle.store.rows.map((row) => `${row.kind}:${row.text.trim()}`);
    const partialIdx = rows.findIndex((text) => text === 'assistant:partial answer that stalled');
    const retryIdx = rows.findIndex((text) =>
      text.startsWith('summary:↻ provider retry 1 — stream stalled')
    );
    const regenIdx = rows.findIndex((text) => text === 'assistant:regenerated answer');
    assert.ok(partialIdx >= 0, `the partial committed: ${JSON.stringify(rows)}`);
    assert.ok(
      retryIdx > partialIdx,
      `the retry marker separates the generations: ${JSON.stringify(rows)}`
    );
    assert.ok(
      regenIdx > retryIdx,
      `the regenerated answer is its own row, never spliced: ${JSON.stringify(rows)}`
    );
    instance.unmount();
    await sleep(150);
  }

  // 4k. Ctrl+D never destroys a draft: quitting on a non-empty composer gets
  // a pointer instead (A12.96 — the draft is the user's work).
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    for (const ch of 'precious draft') instance.stdin.write(ch);
    await sleep(60);
    instance.stdin.write('\x04'); // Ctrl+D on a non-empty draft
    await sleep(60);
    assert.ok(instance.lastFrame().includes('precious draft'), 'the draft survives Ctrl+D');
    assert.ok(instance.lastFrame().includes('Ctrl+D quits'), 'the refusal explains itself');
    // Clear the draft (Esc-Esc), then Ctrl+D may exit.
    instance.stdin.write('\x1b');
    await sleep(40);
    instance.stdin.write('\x1b');
    await sleep(60);
    assert.ok(!instance.lastFrame().includes('precious draft'), 'draft dropped deliberately');
    instance.unmount();
    await sleep(150);
  }

  // 4l. A failed MCP server is visible at boot, not buried in /mcp.
  {
    const { instance, handle } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      mcpServers: [
        { name: 'docs', state: 'connected', toolCount: 4 },
        { name: 'broken-server', state: 'failed', error: 'spawn ENOENT' },
      ],
    });
    const ok = await waitFor(() =>
      handle.store.rows.some(
        (row) =>
          row.kind === 'system' &&
          row.text.includes('⚠ 1 MCP server failed to start (broken-server)') &&
          row.text.includes('/mcp for details')
      )
    );
    assert.ok(
      ok,
      `the boot row names the failure: ${JSON.stringify(
        handle.store.rows.map((r) => `${r.kind}:${r.text}`)
      )}`
    );
    instance.unmount();
    await sleep(150);
  }

  // 4m. The verbose transcript state is visible in the chrome (A9.72): the
  // status row carries a `verbose` badge and the hint names the exit key.
  {
    const status = renderStatusRight(
      { running: false, tokens: 0, taskCount: 0, queueLength: 0, verbose: true },
      80
    ).text;
    assert.match(status, /verbose/, 'the status row badges the verbose state');
    const hint = renderHint(
      { running: false, tokens: 0, taskCount: 0, queueLength: 0, verbose: true },
      80
    ).text;
    assert.match(hint, /ctrl\+o to exit/, 'the hint names the toggle');
  }

  // 4n. Tab-to-amend (A6.54): Tab swaps option 1 to "Yes, and tell moss what
  // to do next" and Enter answers `amend` — the tool runs and the composer
  // message the user types next steers it.
  {
    const { getCliApprovalViewAsker, CLI_APPROVAL_OPTIONS, CLI_APPROVAL_FOOTER } =
      await import('../dist/cli/approval-view.js');
    const { instance, handle } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    const asker = getCliApprovalViewAsker();
    assert.ok(typeof asker === 'function', 'the shell installs the view asker');
    const pending = asker({
      title: 'Create file',
      subject: 'demo.txt',
      preview: ['+ hello'],
      question: 'Do you want to create demo.txt?',
      options: [...CLI_APPROVAL_OPTIONS],
      footer: CLI_APPROVAL_FOOTER,
    });
    await waitFor(() => instance.lastFrame().includes('waiting for you'));
    instance.stdin.write('\t'); // Tab arms amend
    await sleep(80);
    assert.ok(
      instance.lastFrame().includes('Yes, and tell moss what to do next'),
      'option 1 becomes the amend wording'
    );
    assert.ok(instance.lastFrame().includes('Tab to amend'), 'the footer names the toggle');
    instance.stdin.write('\r'); // Enter on option 1 → amend
    const answer = await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]);
    assert.equal(answer, 'amend', 'Enter answers amend');
    assert.ok(
      handle.store.rows.some((r) => r.text.startsWith('approval: amend')),
      'the amend decision is committed'
    );
    assert.ok(
      instance.lastFrame().includes('type what moss should do next'),
      'the follow-up affordance is staged'
    );
    instance.unmount();
    await sleep(150);
  }

  // 4o. A previous session is discoverable at boot: one row names it and the
  // flag that resumes it (crash recovery without a picker).
  {
    const { instance, handle } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      listSessions: async () => [
        {
          key: 'cli-1',
          title: 'the cpp demo task',
          messageCount: 12,
          updatedAt: Date.now(),
          current: true,
        },
        {
          key: 'cli-0',
          title: 'yesterday debugging',
          messageCount: 40,
          updatedAt: Date.now() - 86_400_000,
        },
      ],
    });
    const ok = await waitFor(() =>
      handle.store.rows.some(
        (r) => r.kind === 'system' && r.text.includes('previous session: yesterday debugging')
      )
    );
    assert.ok(
      ok,
      `the boot hint names the resumable session: ${JSON.stringify(
        handle.store.rows.map((r) => `${r.kind}:${r.text}`)
      )}`
    );
    instance.unmount();
    await sleep(150);
  }

  // 4p. Plan-mode exit ritual: a plan run that produced a plan gets the
  // `Ready to code?` gate; option 1 flips to accept-edits and dispatches the
  // execution run (A7.60-62). Esc keeps planning.
  {
    const { getCliInteractionMode, setCliInteractionMode } =
      await import('../dist/cli/interaction-mode.js');
    const before = getCliInteractionMode();
    setCliInteractionMode('plan');
    const planCalls = [];
    const planAgent = {
      async *streamChat(_sk, message) {
        planCalls.push(message);
        const answer =
          planCalls.length > 1 ? 'executing' : `## Plan\n${'step for the refactor. '.repeat(30)}`;
        yield { type: 'text_delta', delta: answer };
        yield { type: 'done', result: { response: answer, stopReason: 'end_turn' } };
      },
    };
    const { instance } = mount({ agent: planAgent, workspaceDir: '/tmp/ws' });
    await type(instance, 'plan the refactor');
    const gated = await waitFor(() => instance.lastFrame().includes('Ready to code?'));
    assert.ok(gated, `the plan gate opens after a plan run: ${instance.lastFrame().slice(0, 160)}`);
    instance.stdin.write('1'); // Direct option key — proceed with accept-edits
    const executed = await waitFor(() => planCalls.length === 2);
    assert.ok(executed, `the approved plan dispatches execution: ${JSON.stringify(planCalls)}`);
    assert.match(planCalls[1], /approved — proceed with execution/);
    assert.equal(
      getCliInteractionMode(),
      'acceptEdits',
      'option 1 flips the mode to accept-edits for the execution run'
    );
    await waitFor(() => instance.lastFrame().includes('executing'));
    setCliInteractionMode(before || 'default');
    instance.unmount();
    await sleep(150);
  }

  // 4q. Ctrl+S stashes the draft; a second Ctrl+S swaps it back (A2.24).
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    for (const ch of 'urgent goal draft') instance.stdin.write(ch);
    await sleep(60);
    instance.stdin.write('\x13'); // Ctrl+S → stash
    await sleep(60);
    assert.ok(instance.lastFrame().includes('› stashed'), 'the badge appears');
    assert.ok(
      !instance
        .lastFrame()
        .split('\n')
        .some((row) => row.startsWith('❯ urgent goal draft')),
      'the composer is free'
    );
    instance.stdin.write('quick question');
    await sleep(60);
    instance.stdin.write('\x13'); // Ctrl+S again → stash the new draft, restore the old
    await sleep(60);
    assert.ok(
      instance.lastFrame().includes('❯ urgent goal draft'),
      'Ctrl+S swaps back to the parked draft'
    );
    instance.unmount();
    await sleep(150);
  }

  // 4r. Markdown headings render bold + italic + underlined (A10.75).
  {
    const { renderMarkdown } = await import('../dist/cli/tui/markdown.js');
    const heading = renderMarkdown('## Ship it', 40).find((l) => l.text.includes('Ship it'));
    assert.ok(heading, 'the heading renders');
    assert.equal(
      heading.bold && heading.italic && heading.underline,
      true,
      'headings are bold + italic + underlined'
    );
  }

  // 4s. Ctrl+R searches earlier prompts: filter live, Enter STAGES the match
  // into the composer (A2.22 — using is not sending), Esc cancels.
  {
    calls.length = 0;
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    await type(instance, 'deploy the camera pipeline to the board');
    await waitFor(() => calls.length === 1);
    await type(instance, 'unrelated second prompt');
    await waitFor(() => calls.length === 2);
    instance.stdin.write('\x12'); // Ctrl+R opens the search overlay
    await sleep(80);
    assert.ok(instance.lastFrame().includes('⌕'), 'the search box opens');
    for (const ch of 'camera') instance.stdin.write(ch);
    await sleep(120);
    assert.ok(instance.lastFrame().includes('⌕ camera'), 'the query is echoed in the search box');
    assert.ok(
      instance.lastFrame().includes('❯ deploy the camera pipeline'),
      'the match is selected in the overlay'
    );
    // Pure filtering contract (the frame cannot prove non-matches are gone:
    // the transcript legitimately holds the other prompt's user row).
    {
      const { filterHistory } = await import('../dist/cli/tui/history-search.js');
      const matches = filterHistory(
        ['deploy the camera pipeline to the board', 'unrelated second prompt'],
        'camera'
      );
      assert.deepEqual(matches, ['deploy the camera pipeline to the board'], 'filter narrows');
      assert.deepEqual(
        filterHistory(['b', 'a', 'a', 'b'], '').slice(0, 2),
        ['b', 'a'],
        'newest first, deduplicated'
      );
    }
    instance.stdin.write('\r'); // Enter stages the match
    await sleep(80);
    assert.ok(instance.lastFrame().includes('prompt staged from history'), 'staging is announced');
    assert.equal(calls.length, 2, 'Enter did NOT submit — using is not sending');
    instance.unmount();
    await sleep(150);
  }

  // 4t. Skills are first-class commands (the Qoder pattern): they ride the
  // `/` palette outside the static table, and `/skill-name` dispatches a run
  // that tells the agent to use the skill.
  {
    calls.length = 0;
    const { instance } = mount({
      agent: createMockAgent(),
      workspaceDir: '/tmp/ws',
      skills: [{ name: 'flash-rdk', description: 'flash the RDK board via XBurn' }],
    });
    for (const ch of '/fla') instance.stdin.write(ch);
    await sleep(120);
    assert.ok(instance.lastFrame().includes('/flash-rdk'), 'the skill is offered by the palette');
    assert.ok(instance.lastFrame().includes('flash the RDK board'), 'with its description');
    instance.stdin.write('\r'); // palette Enter runs the highlighted row
    const dispatched = await waitFor(() => calls.length === 1);
    assert.ok(dispatched, 'the skill command dispatches a run');
    assert.match(calls[0].message, /Use the "flash-rdk" skill/, 'the run invokes the skill');
    instance.unmount();
    await sleep(150);
  }

  // 4u. Fenced code blocks are syntax highlighted (A10.77): keywords, strings
  // and numbers carry colour runs while the text itself never changes.
  {
    const { renderMarkdown } = await import('../dist/cli/tui/markdown.js');
    const { highlightCodeLine, normalizeCodeLang } = await import('../dist/cli/tui/code-style.js');
    assert.equal(normalizeCodeLang('TypeScript'), 'ts', 'lang aliases fold');
    assert.equal(normalizeCodeLang('markdown'), '', 'unknown langs stay plain');
    const block = renderMarkdown('```ts\nconst name = "moss"; // hi\n```', 60);
    const codeLine = block.find((l) => l.text.includes('const name'));
    assert.ok(codeLine?.runs, 'the code line carries runs');
    const colored = codeLine.runs.filter((r) => r.color);
    assert.ok(
      colored.some((r) => r.color === 'magenta' && r.text === 'const'),
      'keywords are magenta'
    );
    assert.ok(
      colored.some((r) => r.color === 'green' && r.text === '"moss"'),
      'strings are green'
    );
    assert.ok(
      colored.some((r) => r.color === 'gray' && r.text === '// hi'),
      'comments are gray'
    );
    assert.equal(
      codeLine.runs.map((r) => r.text).join(''),
      codeLine.text,
      'runs concatenate back to the exact line'
    );
    const long = renderMarkdown('```ts\n' + 'x'.repeat(120) + '\n```', 60);
    const clipped = long.find((l) => l.text.startsWith('│'));
    assert.ok(clipped?.text.endsWith('…'), 'long lines are clipped');
    assert.equal(clipped.runs, undefined, 'clipped lines drop runs instead of lying');
    assert.equal(highlightCodeLine('plain words', 'markdown'), undefined, 'no lang, no runs');
  }

  // 4v. `moss resume` boots into the in-TUI session picker: rows carry title
  // and relative age, Enter resumes IN PLACE (replay + the next run goes to
  // the picked session's key), Esc keeps a fresh session (A12.88).
  {
    calls.length = 0;
    const agent = {
      config: {
        model: 'm-test',
        sessionStore: {
          loadMessages: async (key) =>
            key === 'cli-old'
              ? [
                  { role: 'user', content: 'old question' },
                  { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
                ]
              : [],
        },
      },
      asyncTasks: { list: () => [] },
      async *streamChat(sessionKey, message) {
        calls.push({ sessionKey, message });
        yield {
          type: 'done',
          result: { response: `ok ${message.slice(0, 6)}`, stopReason: 'end_turn' },
        };
      },
    };
    const { instance, handle } = mount({
      agent,
      workspaceDir: '/tmp/ws',
      resumePicker: true,
      listSessions: async () => [
        {
          key: 'cli-old',
          title: 'the old session',
          messageCount: 4,
          updatedAt: Date.now() - 300_000,
        },
        {
          key: 'cli-other',
          title: 'other work',
          messageCount: 2,
          updatedAt: Date.now() - 86_400_000,
        },
      ],
    });
    const opened = await waitFor(
      () =>
        instance.lastFrame().includes('Resume session') &&
        instance.lastFrame().includes('the old session')
    );
    assert.ok(opened, 'the picker opens at boot with real rows');
    assert.ok(instance.lastFrame().includes('5m'), 'relative age shows');
    instance.stdin.write('\r'); // Enter on the newest session
    const resumed = await waitFor(() =>
      handle.store.rows.some((r) => r.text.includes('resumed cli-old'))
    );
    assert.ok(resumed, 'the resume is committed');
    assert.ok(
      handle.store.rows.some((r) => r.text.includes('old question')),
      'the picked session replays into the transcript'
    );
    await type(instance, 'next message');
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].sessionKey, 'cli-old', 'the run goes to the picked session');
    instance.unmount();
    await sleep(150);
  }

  // 4w. Approval option labels say what the answer ACTUALLY grants (A6.52):
  // workspace file edits vs eligible tools vs no session trust at all, and
  // the Fetch dialog's network wording (A6.53).
  {
    const { buildCliApprovalView } = await import('../dist/cli/approval-view.js');
    const fileView = buildCliApprovalView({
      title: 'Edit file',
      subject: 'a.ts',
      detail: ['+ x'],
      question: 'Do you want to make this edit to a.ts?',
      trustOptionLabel: 'Yes, and don\u2019t ask again for file edits this session',
    });
    assert.match(fileView.options[1].label, /file edits this session/);
    assert.equal(fileView.options[2].label, 'No', 'no override keeps the default');
    const fetchView = buildCliApprovalView({
      title: 'Fetch',
      detail: [],
      question: 'Do you want to proceed?',
      trustOptionLabel: 'Yes (no session trust for web_fetch)',
      trustOptionAvailable: false,
      denyOptionLabel: 'No, and tell moss what to do differently (esc)',
    });
    assert.equal(fetchView.options.length, 2, 'unavailable session trust is not shown');
    assert.equal(fetchView.options[0].key, '1', 'allow remains option 1');
    assert.match(fetchView.options[1].label, /tell moss what to do differently/);
  }
}

assert.equal(typeof runTuiApp, 'function', 'the TTY entry point is exported');

console.log('[PASS] TUI foundation (transcript/paste/Esc/replay)');
