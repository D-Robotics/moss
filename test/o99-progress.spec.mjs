#!/usr/bin/env node
/**
 * O99 — long-run progress (stderr / TUI).
 * Red/green: revert src/ → new behaviors fail; pure formatters / print guard stay green.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const progress = () => require('../dist/cli/run-progress.js');
const output = () => require('../dist/cli/output.js');
const print = () => require('../dist/cli/print.js');

function fakeClock(start = 0) {
  let now = start;
  /** @type {Array<{ fire: () => void }>} */
  const timers = [];
  return {
    now: () => now,
    setInterval(handler, _ms) {
      const entry = { fire: handler };
      timers.push(entry);
      return {
        clear() {
          const i = timers.indexOf(entry);
          if (i >= 0) timers.splice(i, 1);
        },
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers]) t.fire();
    },
  };
}

test('formatter: thinking-wait buckets 30/60/90 and has no empty slogans', () => {
  const { formatThinkingWaitLine, thinkingWaitSeconds } = progress();
  assert.equal(thinkingWaitSeconds(29_999), 30);
  assert.equal(thinkingWaitSeconds(30_000), 30);
  assert.equal(thinkingWaitSeconds(60_000), 60);
  assert.equal(thinkingWaitSeconds(90_000), 90);
  assert.equal(formatThinkingWaitLine(30_000, false), 'Still reasoning, waited 30s');
  assert.equal(formatThinkingWaitLine(60_000, true), '正在推理，已等待 60s');
  assert.ok(!/working|thinking…/i.test(formatThinkingWaitLine(30_000, false)));
});

test('formatter: tool start/running include real tool+target (en+zh)', () => {
  const { formatToolStartLine, formatToolRunningLine } = progress();
  const startEn = formatToolStartLine('edit_file', { path: 'src/hooks.ts' }, false);
  assert.ok(startEn.includes('edit_file') && startEn.includes('hooks.ts'));
  const startZh = formatToolStartLine('edit_file', { path: 'src/hooks.ts' }, true);
  assert.ok(startZh.includes('正在调用') && startZh.includes('hooks.ts'));
  const runEn = formatToolRunningLine('exec', { command: 'npm run check' }, 90, false);
  assert.ok(runEn.includes('npm run check') && runEn.includes('90s'));
});

test('formatter: unfinished reason for max_turns (O98 alignment)', () => {
  const { unfinishedReasonFromStop, formatUnfinishedLine } = progress();
  assert.ok(unfinishedReasonFromStop('max_turns_reached', false));
  assert.ok(formatUnfinishedLine('hit the turn limit', false).startsWith('Unfinished:'));
  assert.ok(formatUnfinishedLine('已到回合上限', true).startsWith('未完成：'));
});

test('tracker: ≥90s silence emits thinking-wait at least every 60s (en)', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(1_000);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: false,
    emitToolBoundaries: true,
    clock,
  });
  tracker.onEvent({ type: 'turn_start', turn: 1 });
  for (let i = 0; i < 18; i++) clock.advance(5_000);
  tracker.dispose();
  const waits = lines.filter((l) => /Still reasoning, waited (\d+)s/.test(l));
  assert.ok(waits.length >= 2, `expected ≥2 wait lines, got ${JSON.stringify(lines)}`);
  assert.ok(lines.every((l) => !/^(working|thinking)…?$/i.test(l.trim())));
});

test('tracker: zh thinking-wait wording', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(0);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: true,
    emitToolBoundaries: false,
    clock,
  });
  tracker.onEvent({ type: 'turn_start', turn: 1 });
  for (let i = 0; i < 8; i++) clock.advance(5_000);
  tracker.dispose();
  assert.ok(
    lines.some((l) => l.includes('正在推理，已等待')),
    JSON.stringify(lines)
  );
});

test('tracker: tool_progress line names the command (not a slogan)', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(0);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: false,
    emitToolBoundaries: true,
    clock,
  });
  tracker.onEvent({
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'c1',
    input: { command: 'npm test' },
  });
  tracker.onEvent({
    type: 'tool_progress',
    toolName: 'exec',
    toolCallId: 'c1',
    elapsedSec: 60,
  });
  tracker.dispose();
  assert.ok(
    lines.some((l) => l.includes('npm test') && l.includes('60s')),
    JSON.stringify(lines)
  );
});

test('tracker: unfinished last line on max_turns_reached', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(0);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: false,
    emitToolBoundaries: true,
    clock,
  });
  tracker.onEvent({
    type: 'done',
    result: {
      response: 'partial',
      toolCalls: [],
      toolResults: [],
      stopReason: 'max_turns_reached',
    },
  });
  tracker.dispose();
  assert.ok(
    lines.some((l) => /^Unfinished:/.test(l)),
    JSON.stringify(lines)
  );
});

test('tracker: identical progress does not stack ≥3 times', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(0);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: false,
    emitToolBoundaries: true,
    clock,
  });
  for (let i = 0; i < 5; i++) {
    tracker.onEvent({
      type: 'tool_progress',
      toolName: 'exec',
      toolCallId: 'c1',
      elapsedSec: 30,
    });
  }
  tracker.dispose();
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === lines[i - 1]) run++;
    else run = 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun < 3, `stacked ${maxRun}: ${JSON.stringify(lines)}`);
});

test('renderer: tool progress on stderr; final answer only on stdout', () => {
  const { createCliRunRenderer } = output();
  const stderrChunks = [];
  const stdoutChunks = [];
  const renderer = createCliRunRenderer({
    detailMode: 'progress',
    interactive: false,
    stderr: { write: (s) => stderrChunks.push(String(s)), isTTY: false },
    stdout: { write: (s) => stdoutChunks.push(String(s)), isTTY: false },
  });
  renderer.handle({ type: 'turn_start', turn: 1 });
  renderer.handle({
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 't1',
    input: { path: 'src/cli/hooks.ts' },
  });
  renderer.handle({
    type: 'tool_progress',
    toolName: 'read_file',
    toolCallId: 't1',
    elapsedSec: 45,
  });
  renderer.handle({
    type: 'tool_end',
    toolName: 'read_file',
    toolCallId: 't1',
    result: 'ok',
    isError: false,
  });
  renderer.handle({ type: 'text_delta', delta: 'FINAL_ANSWER_ONLY' });
  renderer.handle({
    type: 'done',
    result: {
      response: 'FINAL_ANSWER_ONLY',
      toolCalls: [],
      toolResults: [],
      stopReason: 'end_turn',
    },
  });
  renderer.dispose();
  const stderrText = stderrChunks.join('');
  const stdoutText = stdoutChunks.join('');
  assert.ok(stdoutText.includes('FINAL_ANSWER_ONLY'));
  assert.ok(!stderrText.includes('FINAL_ANSWER_ONLY'));
  assert.ok(/read_file|hooks\.ts/.test(stderrText), 'tool start should appear on stderr');
  // Must include the O99 tool_progress line (goes red if wiring/module missing).
  assert.ok(
    /Running read_file|正在跑 read_file|45s/.test(stderrText),
    `expected tool_progress elapsed line on stderr, got: ${stderrText.slice(0, 400)}`
  );
});

test('renderer: unfinished stopReason prints clear last-line reason', () => {
  const { createCliRunRenderer } = output();
  const stderrChunks = [];
  const renderer = createCliRunRenderer({
    detailMode: 'progress',
    interactive: false,
    stderr: { write: (s) => stderrChunks.push(String(s)), isTTY: false },
    stdout: { write: () => {}, isTTY: false },
  });
  renderer.handle({
    type: 'done',
    result: {
      response: 'halfway',
      toolCalls: [],
      toolResults: [],
      stopReason: 'max_turns_reached',
    },
  });
  renderer.dispose();
  assert.ok(/Unfinished:|未完成：/.test(stderrChunks.join('')), stderrChunks.join(''));
});

test('short-task guard: ≤10s run emits ≤3 tracker progress lines', () => {
  const { createRunProgressTracker } = progress();
  const lines = [];
  const clock = fakeClock(0);
  const tracker = createRunProgressTracker({
    sink: { write: (l) => lines.push(l) },
    zh: false,
    emitToolBoundaries: true,
    clock,
  });
  tracker.onEvent({ type: 'turn_start', turn: 1 });
  tracker.onEvent({
    type: 'tool_start',
    toolName: 'write_file',
    toolCallId: 'c1',
    input: { path: 'calc.py' },
  });
  clock.advance(2_000);
  tracker.onEvent({
    type: 'tool_end',
    toolName: 'write_file',
    toolCallId: 'c1',
    result: 'ok',
    isError: false,
  });
  tracker.onEvent({ type: 'text_delta', delta: 'done' });
  clock.advance(3_000);
  tracker.onEvent({
    type: 'done',
    result: { response: 'done', toolCalls: [], toolResults: [], stopReason: 'end_turn' },
  });
  tracker.dispose();
  assert.ok(lines.length <= 3, `got ${lines.length}: ${JSON.stringify(lines)}`);
});

test('print.ts: tool_progress yields no stdout stream-json events', () => {
  // New behavior: explicit empty array (main returned undefined for unknown types).
  const state = print().createHeadlessPrintState({
    sessionId: 's1',
    model: 'm',
    startTime: Date.now(),
  });
  const events = print().formatHeadlessStreamEvent(state, {
    type: 'tool_progress',
    toolName: 'exec',
    toolCallId: 'c1',
    elapsedSec: 30,
  });
  assert.ok(Array.isArray(events), 'must return an array, not undefined');
  assert.equal(events.length, 0);
});

test('guard: default CLI detail mode is still progress (main-green)', () => {
  // Exists on main; must stay green after reverting O99 src.
  const { resolveCliDetailMode } = output();
  assert.equal(resolveCliDetailMode([], {}), 'progress');
});
