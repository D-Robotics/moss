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
  visibleRows,
} from '../dist/cli/tui/render-bridge.js';
import {
  renderHint,
  renderRunSummary,
  renderStatusRight,
  renderTranscriptRows,
} from '../dist/cli/tui/transcript.js';
import { TuiAppRoot, runTuiApp } from '../dist/cli/tui/app.js';
import { buildResumeReplay } from '../dist/cli/tui-utils.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  applyAgentEvent(store, { type: 'text_delta', delta: 'ok' });
  assert.equal(store.run.retry, undefined, 'progress clears the retry notice');

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
  });
  assert.equal(store.usage.cacheReadTokens, 4000);
  assert.match(formatUsage(store.usage), /4k prompt-cache hits/, 'cache hits are visible');
  endRun(store, false);
}

// ─── 2c. Run summary tokens + context high-water status ─────────────────────

{
  const done = renderRunSummary(12_000, false, 200, { input: 3200, output: 891 })
    .map((l) => l.text)
    .join('\n');
  assert.match(done, /✻ \w+ for 12s · ↑ 3\.2k ↓ 891/, 'the run summary shows token spend');
  const halted = renderRunSummary(4000, true, 200, { input: 0, output: 0 })
    .map((l) => l.text)
    .join('\n');
  assert.match(halted, /· interrupted$/, 'no-token runs stay clean');
  assert.ok(!renderRunSummary(4000, false, 200).some((l) => l.text.includes('↑')));

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

// ─── 3. Status/hint chrome + transcript window ──────────────────────────────

{
  const status = renderStatusRight(
    { running: true, model: 'deepseek-flash@latest', tokens: 1500, taskCount: 0, queueLength: 0 },
    80
  ).text;
  assert.match(status, /● running/, 'a live run is announced in the status line');
  assert.match(status, /deepseek-flash@latest/, 'the active model is shown');
  assert.match(status, /1\.5k tokens/, 'session usage is shown');
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
    const ok = await waitFor(() => instance.lastFrame().includes('Esc interrupt the run'));
    assert.ok(ok, `help text visible: ${JSON.stringify(instance.lastFrame().slice(0, 200))}`);
    assert.ok(
      instance.lastFrame().includes('/resume [id]'),
      'the reference prints the whole command list'
    );
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
    await waitFor(() => instance.lastFrame().includes('paste: 50 lines'));
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
        instance.lastFrame().includes('earlier answer') &&
        instance.lastFrame().includes('resumed — replayed 3 rows')
    );
    assert.ok(ok, `replay rendered: ${instance.lastFrame().slice(0, 200)}`);
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

  // 4h. Ctrl+V prints the evidence block (the chord evidence moved to).
  {
    const { instance } = mount({ agent: createMockAgent(), workspaceDir: '/tmp/ws' });
    instance.stdin.write('\x16');
    const ok = await waitFor(() => instance.lastFrame().includes('Evidence'));
    assert.ok(ok, `Ctrl+V prints evidence: ${instance.lastFrame().slice(0, 160)}`);
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
    await waitFor(() => instance.lastFrame().includes('/resume [id]'));
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
}

assert.equal(typeof runTuiApp, 'function', 'the TTY entry point is exported');

console.log('[PASS] TUI foundation (transcript/paste/Esc/replay)');
