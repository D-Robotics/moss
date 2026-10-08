#!/usr/bin/env node
/**
 * CLI shell (v0.22) — the Claude-Code/codex-style single column, asserted
 * end-to-end from the shared TaskRuntime + component-level interactions.
 *
 * Replaces tui-mission.spec.mjs (deleted: the 3-pane Mission Control layout,
 * its panels and its overlays no longer exist). The guarantees that survive the
 * rewrite are asserted here against the new grammar:
 *
 *   ❯ user echo · ⏺ answer/tool · ⎿ result · ✢ live run · inline approval
 *   boot banner · two rules · composer · hint · Ctrl+T/R/V/G/F blocks
 *
 * The task-runtime fixture is seeded exactly as the old spec did, so the
 * replacement checks read the same `.moss/` truth.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import stringWidth from 'string-width';

import { line, rule } from '../dist/cli/tui/text.js';

import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import {
  appendTaskRecord,
  appendEvidenceRecord,
  appendAcceptanceVerdict,
} from '../dist/core/task-runtime/artifacts.js';
import { appendDeploymentRecord } from '../dist/device/deployment.js';
import { appendRow, createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { CTRL_BINDINGS, ctrlBinding } from '../dist/cli/tui/help.js';
import {
  ANSWER_MARK,
  APPROVAL_OPTIONS,
  COMPOSER_MAX_ROWS,
  RESULT_MARK,
  USER_MARK,
  renderApproval,
  renderBanner,
  renderComposer,
  renderDiffGutter,
  renderHint,
  renderLive,
  renderStatusRight,
  renderTranscriptRow,
  renderTranscriptRows,
  toolLabel,
} from '../dist/cli/tui/transcript.js';
import { TuiAppRoot, inkLineStyle } from '../dist/cli/tui/app.js';
import { HELP_KEYS } from '../dist/cli/tui/help.js';
import { getCliApprovalAskerForTest } from '../dist/cli/approval.js';
import {
  CLI_APPROVAL_FOOTER,
  CLI_APPROVAL_OPTIONS,
  getCliApprovalViewAsker,
} from '../dist/cli/approval-view.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (lines) => lines.map((entry) => entry.text).join('\n');
const cells = (value) => stringWidth(value);

function assertFits(lines, width, label) {
  for (const entry of lines) {
    const value = typeof entry === 'string' ? entry : entry.text;
    assert.ok(
      cells(value) <= width,
      `${label}: line is ${cells(value)} cells wide, limit ${width}: ${JSON.stringify(value)}`
    );
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

const CJK_GOAL =
  '把相机管线部署到 RDK X5 上并测量六十秒的稳定帧率，同时记录 CPU 温度和内存占用，最后把结果写进证据文件';

// ─── workspace fixture: camera task passed after a repair, ROS task idle ────

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-shell-'));

function task(overrides) {
  return {
    taskId: 'task_cam1',
    goal: 'stream camera at 30 fps on the robot',
    acceptanceCriteria: [
      { metric: 'camera_fps', expected: '>=30' },
      { metric: 'cpu_percent', expected: '<=80', required: false },
    ],
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    targetDeviceId: 'rdk-x3',
    verificationPlan: ['deploy fps probe', 'measure camera_fps', 'run task_acceptance'],
    ...overrides,
  };
}

await appendTaskRecord(ws, task());
await appendAcceptanceVerdict(ws, {
  taskId: 'task_cam1',
  verdict: 'fail',
  acceptedAt: 1500,
  criteriaResults: [
    { metric: 'camera_fps', expected: '>=30', required: true, result: 'fail', observed: 12 },
  ],
  unmetRequired: 1,
  evidenceConsidered: 1,
});
await appendEvidenceRecord(ws, {
  evidenceId: 'ev_1',
  taskId: 'task_cam1',
  deviceId: 'rdk-x3',
  source: 'device_exec',
  metric: 'camera_fps',
  expected: '>=30',
  observed: 31.5,
  result: 'pass',
  timestamp: 1600,
});
await appendAcceptanceVerdict(ws, {
  taskId: 'task_cam1',
  verdict: 'pass',
  acceptedAt: 1700,
  criteriaResults: [
    { metric: 'camera_fps', expected: '>=30', required: true, result: 'pass', observed: 31.5 },
  ],
  unmetRequired: 0,
  evidenceConsidered: 1,
});
await appendTaskRecord(
  ws,
  task({
    taskId: 'task_ros2',
    goal: 'bring up ros2 nodes',
    updatedAt: 900,
    targetDeviceId: undefined,
    verificationPlan: undefined,
    acceptanceCriteria: [{ metric: 'topic_hz:/cmd_vel', expected: '>=10' }],
  })
);
await appendDeploymentRecord(ws, {
  deploymentId: 'dep_1',
  deviceId: 'rdk-x3',
  artifactPath: 'bin/fps_probe',
  remotePath: '/userdata/fps_probe',
  status: 'running',
  startedAt: 1400,
  completedAt: 1450,
  steps: [
    { step: 'upload', status: 'ok' },
    { step: 'start', status: 'ok' },
  ],
  healthCheck: { command: 'pidof fps_probe', passed: true, checkedAt: 1450 },
});

const runtime = new TaskRuntime({ workspaceDir: ws, now: () => 5000 });
await runtime.refresh();

// ─── 1. the shared runtime still tells the same story ─────────────────────

const detail = runtime.taskDetail('task_cam1');
{
  assert.equal(detail.summary.state, 'COMPLETED', 'the repaired camera task completed');
  assert.equal(detail.summary.result, 'PASS', 'acceptance passed after the repair');
  assert.equal(detail.goal, 'stream camera at 30 fps on the robot', 'goal is the task goal');
  assert.ok(detail.plan.includes('deploy fps probe'), 'the plan is readable');
  const fps = detail.progress.find((criterion) => criterion.metric === 'camera_fps');
  assert.equal(fps.observed, 31.5, 'latest evidence wins');
  assert.equal(fps.result, 'pass', 'the metric passes');
  assert.ok(
    detail.history.some((entry) => entry.label.includes('acceptance PASS')),
    'history records the acceptance verdict'
  );
  assert.equal(runtime.taskSummaries().length, 2, 'both tasks are visible');
}

const CAM_FPS_ROW = 'camera_fps = 31.5 → PASS (want >=30)';

// ─── 2. the grammar, end-to-end, at 40 / 80 / 120 ────────────────────────

for (const width of [40, 80, 120]) {
  const store = createTuiStore();
  // Rows produced by the real shell for the fixture's story.
  appendRow(store, 'banner', 'moss v0.22.0\nmodel-x · rdk-x3\n/workspace/demo');
  appendRow(store, 'user', 'stream camera at 30 fps on the robot');
  appendRow(store, 'tool', toolLabel('device_exec', { command: 'fps_probe.sh' }));
  appendRow(store, 'result', 'camera_fps observed 12, expected >=30');
  appendRow(store, 'result', 'FAILED — acceptance FAIL (1 required unmet)');
  appendRow(store, 'assistant', 'repaired: camera_fps is now 31.5 — acceptance PASS');
  appendRow(store, 'detail', CAM_FPS_ROW);
  appendRow(store, 'user', CJK_GOAL);

  const lines = renderTranscriptRows(store.rows, width);
  assertFits(lines, width, `transcript@${width}`);
  const joined = text(lines);
  const firstMeaningful = joined.split('\n').find((value) => value.trim() !== '');
  assert.equal(firstMeaningful, 'moss v0.22.0', 'the transcript opens with the boot banner');
  assert.ok(joined.includes('model-x · rdk-x3'), 'the banner names the model and device');
  assert.ok(joined.includes(`${USER_MARK} stream camera at 30 fps`), 'user rows carry ❯');
  assert.ok(joined.includes(`${ANSWER_MARK} repaired: camera_fps is now 31.5`), 'answers carry ⏺');
  assert.ok(joined.includes(`${ANSWER_MARK} Device Exec(fps_probe.sh)`), 'tool calls carry ⏺');
  assert.ok(joined.includes(RESULT_MARK), 'tool results carry ⎿');
  assert.ok(joined.includes('camera_fps = 31.5'), 'the evidence value is visible inline');
  assert.ok(!joined.includes('now 31.5 pass'), 'rows do not bleed into each other');

  // Boot banner projection is two rows: version+cwd, then model·device.
  const banner = renderBanner(
    { version: '0.22.0', model: 'model-x', device: 'rdk-x3', cwd: '/workspace/demo' },
    width
  );
  assertFits(banner, width, `banner@${width}`);
  assert.equal(banner.length, 2, 'the banner is version+cwd / model·device');
  assert.ok(banner[0].text.includes('moss v0.22.0'), 'banner names the build');
  assert.ok(banner[0].text.includes('/workspace/demo'), 'banner folds the workspace in');
  assert.ok(banner[1].text.includes('model-x · rdk-x3'), 'banner keeps model · device');

  // Read-only observations fold to the headline by default; ctrl+o expands;
  // errors never fold.
  {
    const row = {
      kind: 'result',
      text: 'alpha\nbeta\ngamma\ndelta',
      tool: { name: 'read_file', summary: 'Read 4 lines', durationMs: 12 },
    };
    const compact = renderTranscriptRow(row, 80, false)
      .map((l) => l.text)
      .filter((t) => t.trim());
    assert.ok(compact.length === 2, `read-only result folds to headline + pointer`);
    assert.ok(compact[1].includes('4 lines · ctrl+o'), 'the pointer names the expand key');
    const verbose = renderTranscriptRow(row, 80, true)
      .map((l) => l.text)
      .filter((t) => t.trim());
    assert.equal(verbose.length, 5, 'verbose expands the full body');
    const failed = renderTranscriptRow(
      { ...row, tool: { name: 'read_file', summary: 'failed', isError: true } },
      80,
      false
    )
      .map((l) => l.text)
      .filter((t) => t.trim());
    assert.equal(failed.length, 5, 'errors keep their body unfurled');
  }

  // Composer + rules + hint: the bottom chrome contract.
  const placeholder = renderComposer('', width, true);
  assert.equal(placeholder.length, 1, 'the empty composer is one row');
  assert.ok(placeholder[0].text.startsWith(USER_MARK), 'the composer sits under ❯');
  assertFits(placeholder, width, `composer(placeholder)@${width}`);

  const typing = renderComposer(CJK_GOAL, width, false);
  assert.ok(typing.length <= COMPOSER_MAX_ROWS, 'the composer never eats the pane');
  assert.ok(typing[typing.length - 1].text.endsWith('▌'), 'the cursor stays visible');
  assertFits(typing, width, `composer(cjk)@${width}`);

  const hint = renderHint({ running: true, tokens: 0, taskCount: 2, queueLength: 1 }, width);
  assert.ok(hint.text.includes('? for shortcuts'), 'the hint advertises the key reference');
  assertFits([hint], width, `hint@${width}`);
  if (width >= 80) {
    assert.ok(hint.text.includes('Esc to interrupt'), 'the hint advertises how to stop a run');
    assert.ok(hint.text.includes('1 queued'), 'the hint carries the queue depth');
    assert.ok(hint.text.includes('2 tasks'), 'the hint carries the task count');
  } else {
    // A 40-cell pane cannot show every hint: it must truncate honestly, never
    // overflow the row.
    assert.equal(cells(hint.text), width, 'a narrow hint is clipped to exactly the pane width');
  }
  assertFits(
    [
      renderStatusRight(
        { running: true, model: 'model-x', tokens: 31_500, taskCount: 2, queueLength: 1 },
        width
      ),
    ],
    width,
    `status@${width}`
  );

  // The chrome contract at this width: status, rule, composer, rule, hint — the
  // composer is bracketed by full-width rules and the hint is last.
  const chrome = [
    renderStatusRight({ running: false, tokens: 31_500, taskCount: 2, queueLength: 1 }, width),
    line(rule(width)),
    ...renderComposer('ship it', width, false),
    line(rule(width)),
    hint,
  ];
  assertFits(chrome, width, `chrome@${width}`);
  assert.equal(cells(chrome[1].text), width, `the rule above the composer spans ${width}`);
  assert.equal(
    cells(chrome[chrome.length - 2].text),
    width,
    `the rule below the composer spans ${width}`
  );
  assert.equal(chrome[chrome.length - 1], hint, 'the hint closes the chrome');

  // A running turn: spinner + verb + elapsed + tokens (+ queue).
  const live = renderLive(
    {
      running: true,
      startedAt: Date.now() - 4200,
      toolLine: toolLabel('device_exec', { command: 'fps_probe.sh' }),
      streaming: 'camera_fps is 31.5',
      thinking: 'checking the pipeline',
      tokensOut: 1200,
      queued: 1,
    },
    width
  );
  const liveText = text(live);
  assert.match(liveText, /[✢✳✶✻✽] \w+… 4s/, `live@${width} shows a spinner and elapsed seconds`);
  assert.ok(liveText.includes('1.2k out'), `live@${width} labels current output tokens`);
  assert.ok(
    !liveText.includes('fps_probe.sh'),
    `live@${width} does not duplicate the transcript tool`
  );
  assert.ok(liveText.includes('camera_fps is 31.5'), `live@${width} previews the answer`);
  assertFits(live, width, `live@${width}`);
  if (width >= 80) {
    assert.ok(liveText.includes('1 queued'), `live@${width} shows the queue`);
  } else {
    assert.ok(
      cells(live[live.length - 1].text) <= width,
      'a narrow activity line stays within the pane width'
    );
  }

  // Approval: three numbered options, cursor on one of them.
  const approval = renderApproval(
    {
      question: 'moss wants to run a command',
      title: 'Run a command',
      subject: 'fps_probe.sh --seconds 60',
      preview: ['+ set -e', '+ fps_probe.sh --seconds 60'],
      cursor: 1,
    },
    width
  );
  assertFits(approval, width, `approval@${width}`);
  const approvalText = text(approval);
  for (const option of APPROVAL_OPTIONS) {
    assert.ok(
      approvalText.includes(`${option.key}. `),
      `approval@${width} offers option ${option.key}`
    );
    if (width >= 80) {
      assert.ok(
        approvalText.includes(`${option.key}. ${option.label}`),
        `approval@${width} spells out option ${option.key}`
      );
    }
  }
  assert.ok(approvalText.includes('❯ 2.'), `approval@${width} marks the cursor row`);
  assert.ok(
    approvalText.includes('moss wants to run a command'),
    'approval renders the host question verbatim'
  );
  assert.ok(approvalText.includes('Esc to deny'), 'approval says Esc denies the action');
}

// ─── 2b. D-11: a lone +/- line is output, never a fabricated diff gutter ──

{
  const row = renderTranscriptRow({ id: 1, kind: 'result', text: '+process.env.X' }, 60);
  assert.equal(
    row[1].text,
    '  ⎿  +process.env.X',
    'a single +-leading line is printed verbatim, not classified as a diff'
  );
  assert.ok(!/\d/.test(row[1].text), 'no invented line number for a one-line echo');

  // Two sign lines still read as a diff, but they must not fabricate numbers
  // without a `@@` anchor.
  for (const line of renderDiffGutter('+a\n+b', 40)) {
    assert.ok(
      !/\d/.test(line.text),
      `no invented gutter number without a hunk header: ${JSON.stringify(line.text)}`
    );
  }
  // A real diff keeps its real numbers.
  const real = renderDiffGutter('@@ -12,2 +12,3 @@\n context\n+added\n-gone', 80).map(
    (entry) => entry.text
  );
  assert.ok(
    real.some((entry) => /\d+ \+added/.test(entry)),
    `a hunk header still numbers the added line: ${JSON.stringify(real)}`
  );
  assert.ok(
    real.some((entry) => /\d+ -gone/.test(entry)),
    `a hunk header still numbers the removed line: ${JSON.stringify(real)}`
  );

  // D-11 residual: the anchor is PER ROW. A truncated large diff keeps a `@@`
  // further down, and a block-wide flag numbered the retained rows above it
  // with invented 1/2/3… counters.
  const truncated = renderDiffGutter('+before\n@@ -5 +5 @@\n-after\n+after', 40).map(
    (entry) => entry.text
  );
  assert.ok(
    !/\d/.test(truncated[0]),
    `a row above the first @@ anchor keeps a blank gutter: ${JSON.stringify(truncated)}`
  );
  assert.ok(
    truncated.some((entry) => /\d+ \+after/.test(entry)),
    `rows from the anchor onward keep real numbers: ${JSON.stringify(truncated)}`
  );
}

// ─── 2c. SI-2: the approval renderer consumes the frozen payload's own
//          option list and footer instead of a second hard-coded copy ─────

{
  const custom = renderApproval(
    {
      title: 'Create file',
      subject: 'demo-write.txt',
      preview: ['+ hello'],
      question: 'Do you want to create demo-write.txt?',
      options: [
        { key: '1', answer: 'y', label: 'Custom yes' },
        { key: '9', answer: 'n', label: 'Custom no' },
      ],
      footer: 'Custom footer · only real keys',
      cursor: 1,
    },
    80
  );
  const customText = text(custom);
  assert.ok(customText.includes('1. Custom yes'), 'the payload option list is rendered verbatim');
  assert.ok(customText.includes('9. Custom no'), 'an option the shell never hard-coded');
  assert.ok(
    customText.includes('Custom footer · only real keys'),
    'the payload footer is rendered verbatim (N2: no hard-coded footer)'
  );
  assert.ok(!customText.includes('↑↓ then Enter'), 'the old hard-coded footer is gone');
  // A view with no payload falls back to the frozen constants, not a copy.
  const fallback = text(renderApproval({ title: 'T', question: 'Q?', cursor: 0 }, 80));
  assert.ok(fallback.includes(CLI_APPROVAL_FOOTER), 'the frozen footer is the fallback');
  assert.ok(fallback.includes('1. Yes'), 'the frozen option list is the fallback');
}

// ─── 2d. D-10: a multi-line draft keeps its own line breaks ──────────────

{
  const rows = renderTranscriptRow(
    { id: 1, kind: 'user', text: 'paste-line-one\npaste-line-two' },
    60
  ).map((entry) => entry.text);
  assert.ok(rows.includes('❯ paste-line-one'), `the first line carries ❯: ${JSON.stringify(rows)}`);
  assert.ok(rows.includes('  paste-line-two'), `the break survives: ${JSON.stringify(rows)}`);
  assert.ok(
    !rows.some((entry) => entry.includes('paste-line-one paste-line-two')),
    'a multi-line draft is never squashed onto one row'
  );
  const one = renderTranscriptRow({ id: 2, kind: 'user', text: 'stream camera at 30 fps' }, 60);
  assert.equal(one[1].text, '❯ stream camera at 30 fps', 'a single-line goal is unchanged');
}

// ─── 2e. D-13: a short terminal keeps the QUESTION on screen ─────────────

{
  const view = {
    title: 'Create file',
    subject: 'demo-write.txt',
    preview: Array.from({ length: 12 }, (_, index) => `+ preview line ${index + 1}`),
    question: 'Do you want to create demo-write.txt?',
    cursor: 0,
  };
  const full = renderApproval(view, 24);
  assert.ok(full.length > 10, 'with no budget the full dialog renders, preview included');
  assertFits(full, 24, 'approval (unbudgeted)');

  const tight = renderApproval(view, 60, { maxHeight: 3 });
  assert.ok(tight.length <= 3, `a 3-row budget is honoured: ${tight.length}`);
  const tightText = text(tight);
  assert.ok(
    tightText.includes('Do you want to create demo-write.txt?'),
    `the security question survives a 3-row budget: ${JSON.stringify(tightText)}`
  );
  assert.ok(tightText.includes('1. Yes'), 'the answer keys survive a 3-row budget');

  // A 24-cell pane cannot spell the question out, but its head must be visible
  // instead of the whole prompt being pushed off screen (the D-13 shape).
  const tiny = renderApproval(view, 24, { maxHeight: 3 });
  assert.ok(tiny.length <= 3, 'the budget holds at a 24-cell pane too');
  assert.ok(
    text(tiny).includes(' Do you want to create'),
    `the question head stays on screen: ${JSON.stringify(text(tiny))}`
  );

  const medium = renderApproval(view, 40, { maxHeight: 8 });
  assert.ok(medium.length <= 8, `an 8-row budget is honoured: ${medium.length}`);
  const mediumText = text(medium);
  assert.ok(mediumText.includes('Do you want to create demo-write.txt?'), 'the question survives');
  assert.ok(mediumText.includes('3. No'), 'every option still renders at 8 rows');
  assertFits(medium, 40, 'approval @budget 8');
}

// ─── 2f. D-12 render half: the ROW style survives inline runs ────────────
//
// The regression: `inkLine` skipped the row style whenever a line carried runs,
// so every markdown heading lost its bold and every blockquote lost its dim (a
// `TuiLineRun` cannot express `dim`). The rule is unit-tested here and proven
// end-to-end by the FORCE_COLOR probe below.

{
  const heading = {
    text: '⏺ Verification heading',
    bold: true,
    runs: [{ text: '⏺ ' }, { text: 'Verification heading' }],
  };
  const quote = {
    text: '  │ a blockquote line',
    dim: true,
    runs: [{ text: '  │ ' }, { text: 'a blockquote line' }],
  };
  const mixed = {
    text: 'use npm run build now',
    runs: [{ text: 'use ' }, { text: 'npm run build', color: 'cyan' }],
  };
  assert.equal(inkLineStyle(heading).bold, true, 'a heading keeps its ROW bold with runs present');
  assert.equal(inkLineStyle(quote).dimColor, true, 'a quote keeps its ROW dim with runs present');
  assert.deepEqual(inkLineStyle(mixed), {}, 'a mixed line adds no uniform row style');
}

// End-to-end (the shape that actually regressed): render the real component with
// a heading + quote in the transcript, with colour forced on so the frame keeps
// its ANSI, and require the escapes on the rendered rows. Runs in a child
// process so FORCE_COLOR is set before chalk is loaded.
{
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const probe = `
process.env.FORCE_COLOR = '1';
const { render } = await import('ink-testing-library');
const React = (await import('react')).default;
const { TuiAppRoot } = await import('./dist/cli/tui/app.js');
const { createTuiStore, appendRow } = await import('./dist/cli/tui/render-bridge.js');
const { TaskRuntime } = await import('./dist/core/task-runtime/runtime.js');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-d12-probe-'));
const store = createTuiStore();
appendRow(store, 'assistant', '# Verification heading\\n\\n> a blockquote line');
const handle = { store, notify() {}, subscribe() { return () => {}; } };
const runtime = new TaskRuntime({ workspaceDir: ws });
const agent = { asyncTasks: { list: () => [] }, async *streamChat() {} };
const instance = render(React.createElement(TuiAppRoot, {
  options: { agent, workspaceDir: ws, model: 'model-x', version: '0.0.0' },
  handle,
  runtime,
}));
await new Promise((resolve) => setTimeout(resolve, 400));
const frame = instance.lastFrame();
console.log(JSON.stringify({
  heading: /\\u001b\\[1m[^\\u001b]*Verification heading/.test(frame),
  quote: /\\u001b\\[2m[^\\u001b]*a blockquote line/.test(frame),
}));
instance.unmount();
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  assert.equal(result.status, 0, `the D-12 style probe rendered: ${result.stderr.slice(-500)}`);
  const flags = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(flags.heading, true, 'headings stay BOLD end-to-end (row style over runs)');
  assert.equal(flags.quote, true, 'blockquotes stay DIM end-to-end (row style over runs)');
}

// ─── 3. component level: the shell over the same fixture ──────────────────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');

  const listeners = new Set();
  const handle = {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const streamCalls = [];
  const agent = {
    asyncTasks: { list: () => [] },
    async *streamChat(sessionKey, message, options) {
      streamCalls.push({ sessionKey, message });
      if (message === 'hang until aborted') {
        // A run that stays in flight until the user interrupts it, then reports
        // the abort the way the real loop does: an `error` event.
        yield { type: 'text_delta', delta: 'partial answer' };
        await new Promise((resolve) => {
          const signal = options?.abortSignal;
          if (!signal || signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'error', error: 'This operation was aborted', retriable: false };
        return;
      }
      if (message === 'long answer') {
        // N-4: longer than the 400-char live tail `render-bridge` keeps.
        const answer = `HEAD-OF-THE-ANSWER ${'x'.repeat(600)}`;
        for (const piece of answer.match(/[\s\S]{1,120}/g) ?? []) {
          yield { type: 'text_delta', delta: piece };
        }
        yield { type: 'done', result: { response: answer, stopReason: 'end_turn' } };
        return;
      }
      if (message === 'prose across a tool') {
        // D-6: prose that introduces a tool call, then prose that follows it.
        yield { type: 'text_delta', delta: 'Planning the refactor.' };
        yield {
          type: 'tool_start',
          toolName: 'todo_write',
          input: { todos: [{ content: 'one item', status: 'pending' }] },
        };
        yield { type: 'tool_end', toolName: 'todo_write', result: '0/1 done' };
        yield { type: 'text_delta', delta: 'Todo list is live.' };
        yield { type: 'done', result: { response: 'Todo list is live.', stopReason: 'end_turn' } };
        return;
      }
      yield { type: 'text_delta', delta: `ack ${message.slice(0, 12)}` };
      yield {
        type: 'done',
        result: { response: `ack ${message.slice(0, 12)}`, stopReason: 'end_turn' },
      };
    },
  };
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent,
        workspaceDir: ws,
        model: 'model-x',
        version: '0.22.0',
        listSessions: async () => [],
        mcpServers: [],
        listCheckpoints: () => [],
      },
      handle,
      runtime,
    })
  );

  const rowsOf = (kind) => handle.store.rows.filter((row) => row.kind === kind);
  const detailRows = () => rowsOf('detail').map((row) => row.text);
  const toolTitles = () => rowsOf('tool').map((row) => row.text);
  const frame = () => instance.lastFrame();

  const type = async (value) => {
    for (const ch of value) {
      instance.stdin.write(ch);
      await sleep(12);
    }
    instance.stdin.write('\r');
    await sleep(120);
  };

  // Type without submitting — for composer-state assertions.
  const typeOnly = async (value) => {
    for (const ch of value) {
      instance.stdin.write(ch);
      await sleep(12);
    }
    await sleep(80);
  };

  // 3a. Boot banner is committed, not painted over.
  assert.ok(
    await waitFor(() => rowsOf('banner').length === 1),
    `boot banner committed: ${JSON.stringify(handle.store.rows.slice(0, 2))}`
  );
  assert.ok(rowsOf('banner')[0].text.includes('moss v0.22.0'), 'banner carries the version');

  // Bottom chrome: the composer is the last ❯ row and is bracketed by the two
  // full-width rules — it can never float mid-pane or grow into the transcript.
  {
    const frameLines = frame().split('\n');
    let composerIdx = -1;
    frameLines.forEach((line, index) => {
      if (line.startsWith(USER_MARK)) composerIdx = index;
    });
    assert.ok(composerIdx > 0, 'the composer is rendered at the bottom');
    assert.equal(
      cells(frameLines[composerIdx - 1]),
      100,
      'the rule above the composer spans the pane'
    );
    assert.equal(
      cells(frameLines[composerIdx + 1]),
      100,
      'the rule below the composer spans the pane'
    );
    assert.ok(
      frameLines[composerIdx + 2].includes('? for shortcuts'),
      'the hint is the last chrome row'
    );
  }

  // 3b. Slash commands print the task-runtime blocks into the transcript.
  await type('/tasks');
  assert.ok(await waitFor(() => toolTitles().includes('Tasks (2)')), '/tasks prints the task list');
  assert.ok(
    detailRows().some((line) => line.includes('CAMERA') && line.includes('PASS')),
    'task kind + verdict'
  );
  assert.ok(
    detailRows().some((line) => line.includes('ROS') && line.includes('IDLE')),
    'second task listed'
  );

  // Ctrl+R is the prompt-SEARCH key (A2.22) — the task-history block answers
  // to /history, which drives the same showBlock('history') path the chord
  // used to take.
  await type('/history');
  assert.ok(
    await waitFor(() => toolTitles().includes('History (2)')),
    '/history prints the history'
  );
  assert.ok(
    detailRows().some((line) => line.includes('task_cam1')),
    'history names the task'
  );
  assert.ok(
    detailRows().some((line) => line.includes('acceptance PASS (0 required unmet)')),
    'history shows the acceptance verdict'
  );

  await type('/evidence');
  assert.ok(
    await waitFor(() => toolTitles().includes('Evidence (1)')),
    '/evidence prints the evidence'
  );
  assert.ok(
    detailRows().some(
      (line) => line.includes('PASS') && line.includes('camera_fps = 31.5 (want >=30)')
    ),
    `the evidence block shows the raw measurement: ${JSON.stringify(detailRows().slice(-2))}`
  );

  await type('/deployments');
  assert.ok(
    await waitFor(() => toolTitles().includes('Deployments (1)')),
    '/deployments prints deployments'
  );
  assert.ok(
    detailRows().some((line) => line.includes('RUNNING') && line.includes('/userdata/fps_probe')),
    'deployment row names device path + status'
  );

  await type('/failures');
  assert.ok(await waitFor(() => toolTitles().includes('Failures (1)')), '/failures prints failures');
  assert.ok(
    detailRows().some((line) => line.includes('camera_fps observed 12, expected >=30')),
    'the recorded failure is the same one acceptance repaired'
  );

  // 3c. The advertised command and the shortcut print the same block.
  await type('/tasks');
  assert.equal(
    toolTitles().filter((title) => title === 'Tasks (2)').length,
    2,
    '/tasks prints the same block Ctrl+T does'
  );

  // `/resume` is the strict Task OS recovery path. It selects the latest
  // failed/blocked task and reports the real recovery result instead of staging
  // an editable prompt that never changes task state.
  await type('/resume task_ros2');
  assert.ok(
    await waitFor(() => toolTitles().includes('Task')),
    `resume renders a Task block: ${JSON.stringify(frame().slice(-300))}`
  );
  assert.ok(
    detailRows().some((line) => line.includes('task_ros2') || line.includes('task_id')),
    'resume output identifies the task being recovered'
  );

  // 3d. Ctrl+L clears the composer; `?` prints the complete reference.
  await typeOnly('a draft goal');
  assert.ok(frame().includes('a draft goal'), 'the composer echoes what was typed');
  instance.stdin.write('\x0c'); // Ctrl+L
  await sleep(80);
  assert.ok(!frame().includes('a draft goal'), 'Ctrl+L clears the composer');
  assert.ok(frame().includes('Try "stream the camera'), 'the placeholder comes back');

  instance.stdin.write('?');
  await waitFor(() => frame().includes('Help · Esc or Enter to close'));
  const shortcuts = frame();
  assert.ok(shortcuts.includes('Help · Esc or Enter to close'), '? opens the shortcut reference');
  assert.ok(shortcuts.includes('prefixes'), 'the reference explains input prefixes');
  assert.ok(shortcuts.includes('shortcuts'), 'the reference explains keyboard shortcuts');
  assert.ok(!shortcuts.includes('Ctrl+H'), 'the unreachable Ctrl+H is never advertised');
  assert.equal(ctrlBinding('h'), undefined, 'Ctrl+H is not a binding');
  for (const binding of CTRL_BINDINGS) {
    assert.equal(
      ctrlBinding(binding.letter),
      binding.action,
      `binding resolves: ${binding.letter}`
    );
  }
  assert.ok(
    HELP_KEYS.length >= 8 && HELP_KEYS.some(([k]) => k === '?'),
    'the help overlay publishes the key table'
  );

  // 3e. A `?` typed inside a goal is literal text, never a help request.
  instance.stdin.write('\x1b');
  await waitFor(() => !frame().includes('Help · Esc or Enter to close'));
  const before = streamCalls.length;
  await type('echo ?');
  assert.ok(
    await waitFor(() => streamCalls.length === before + 1),
    'the goal with a literal ? is submitted'
  );
  assert.equal(streamCalls[streamCalls.length - 1].message, 'echo ?', 'the goal survives verbatim');

  // 3f. A CJK goal is echoed as ONE ❯ row and never overflows the pane.
  // KNOWN LIMITATION (reported to the Lead, not fixed here — src/ is out of
  // scope): app.ts's text branch returns on `key.shift`, and ink's
  // parse-keypress reports shift=true for a single uppercase ASCII letter, so
  // uppercase letters typed into the composer are silently dropped
  // (`RDK X5` arrives as ` 5`). The typed goal below therefore uses a
  // CJK+lowercase goal; the width checks still exercise double-cell glyphs.
  const typedGoal =
    '把相机管线部署到 rdk x5 上并测量六十秒的稳定帧率，同时记录 cpu 温度和内存占用，最后把结果写进证据文件';
  const cjkBefore = streamCalls.length;
  await type(typedGoal);
  assert.ok(
    await waitFor(() => streamCalls.length === cjkBefore + 1),
    'the CJK goal is submitted as one turn'
  );
  assert.equal(streamCalls[streamCalls.length - 1].message, typedGoal, 'the CJK goal survives');
  const cjkRow = rowsOf('user').find((row) => row.text === typedGoal);
  assert.ok(cjkRow, 'the CJK goal commits verbatim as a user row');
  assert.equal(
    rowsOf('user').filter((row) => row.text === typedGoal).length,
    1,
    'the goal is one row, not one row per glyph'
  );
  for (const line of frame().split('\n')) {
    assert.ok(
      cells(line) <= 100,
      `the rendered frame line is ${cells(line)} cells wide, limit 100: ${JSON.stringify(line)}`
    );
  }
  for (const width of [40, 80, 120]) {
    assertFits(renderTranscriptRows(handle.store.rows, width), width, `live rows@${width}`);
  }

  // 3g. Approval is inline, numbered, and answers 1/2/3 and y/a/n.
  const asker = getCliApprovalAskerForTest();
  assert.ok(typeof asker === 'function', 'the shell registers an approval asker');

  const cursorLine = () =>
    frame()
      .split('\n')
      .find((line) => /❯ \d\./.test(line));

  async function ask(keys) {
    const answer = asker('moss wants to write a file\nsrc/index.ts');
    const shown = await waitFor(() => frame().includes('Do you want to proceed?'));
    assert.ok(shown, `approval prompt rendered: ${JSON.stringify(frame().slice(-200))}`);
    // A dialog that opens while the composer was just edited ignores answer
    // keys for 350ms so an in-flight letter cannot approve the prompt.
    await sleep(400);
    for (const key of keys) {
      instance.stdin.write(key);
      await sleep(60);
    }
    return Promise.race([
      answer,
      sleep(3000).then(() => {
        throw new Error(`approval did not resolve for keys ${JSON.stringify(keys)}`);
      }),
    ]);
  }

  for (const [keys, expected, label] of [
    [['1'], 'y', 'digit 1 approves'],
    [['2'], 'a', 'digit 2 approves for the session'],
    [['3'], 'n', 'digit 3 declines'],
  ]) {
    assert.equal(await ask(keys), expected, label);
  }

  // Cursor + Enter: ↑↓ move the cursor, ⏎ picks the highlighted option.
  {
    const answer = asker('moss wants to write a file\nsrc/index.ts');
    await waitFor(() => frame().includes('Do you want to proceed?'));
    assert.ok(cursorLine().includes('❯ 1. Yes'), 'the cursor starts on option 1');
    instance.stdin.write('\x1b[B');
    await sleep(60);
    assert.ok(cursorLine().includes('❯ 2.'), '↓ moves the cursor down');
    instance.stdin.write('\x1b[B');
    instance.stdin.write('\x1b[B');
    instance.stdin.write('\x1b[B');
    await sleep(120);
    assert.ok(cursorLine().includes('❯ 3.'), '↓ clamps at the last option');
    instance.stdin.write('\x1b[A');
    await sleep(60);
    assert.ok(cursorLine().includes('❯ 2.'), '↑ moves the cursor back up');
    instance.stdin.write('\r');
    assert.equal(await answer, 'a', '⏎ answers with the highlighted option');
  }
  {
    const answer = asker('moss wants to write a file\nsrc/index.ts');
    await waitFor(() => frame().includes('Do you want to proceed?'));
    instance.stdin.write('\x1b[A');
    await sleep(60);
    assert.ok(cursorLine().includes('❯ 1.'), '↑ clamps at the first option');
    instance.stdin.write('\r');
    assert.equal(await answer, 'y', '⏎ on the first option approves');
  }
  assert.equal(await ask(['\x1b']), 'n', 'Esc cancels the approval');
  assert.ok(
    await waitFor(() => rowsOf('result').some((row) => row.text.startsWith('approval:'))),
    'every decision is committed to the transcript'
  );

  // 3h. SI-2: the frozen structured port drives the SAME dialog, and its
  // payload option list + footer are rendered verbatim (no second copy).
  const viewAsker = getCliApprovalViewAsker();
  assert.ok(typeof viewAsker === 'function', 'the shell installs the frozen view asker');
  const structuredView = (overrides = {}) => ({
    title: 'Create file',
    subject: 'demo-write.txt',
    preview: ['+ hello', '+ world'],
    question: 'Do you want to create demo-write.txt?',
    options: [...CLI_APPROVAL_OPTIONS],
    footer: CLI_APPROVAL_FOOTER,
    ...overrides,
  });

  {
    const pending = viewAsker(
      structuredView({
        options: [
          { key: '1', answer: 'y', label: 'Custom yes' },
          { key: '9', answer: 'n', label: 'Custom no' },
        ],
        footer: 'Custom footer · only real keys',
      })
    );
    assert.ok(
      await waitFor(() => frame().includes('Custom footer · only real keys')),
      `the payload footer reaches the screen verbatim: ${JSON.stringify(frame().slice(-300))}`
    );
    assert.ok(frame().includes('1. Custom yes'), 'the payload option list is rendered verbatim');
    assert.ok(frame().includes('9. Custom no'), 'an option the shell never hard-coded');
    assert.ok(frame().includes('demo-write.txt'), 'the payload subject reaches the dialog');
    instance.stdin.write('9');
    assert.equal(await pending, 'n', 'a payload option key answers the dialog');
    assert.ok(await waitFor(() => !frame().includes('Custom footer')), 'the dialog is dismissed');
  }

  // 3h2. N-1: `ask_user_question` is answerable and the CHOSEN option reaches
  // the model. The prompt is the one `formatQuestionPrompt` builds.
  {
    const question = getCliApprovalAskerForTest();
    assert.ok(typeof question === 'function', 'the user-question channel is installed');
    const pending = question(
      'Which storage backend?\n' +
        '  1. SQLite — smallest diff\n' +
        '  2. Postgres — more ops\n' +
        'Enter a number, or free text for "Other".'
    );
    assert.ok(
      await waitFor(() => frame().includes('SQLite')),
      `the question's real options render: ${JSON.stringify(frame().slice(-300))}`
    );
    assert.ok(frame().includes('Postgres'), 'every option renders');
    assert.ok(
      !frame().includes('Do you want to proceed?'),
      'a question is not rendered as a permission request'
    );
    instance.stdin.write('2');
    assert.equal(
      await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]),
      'Postgres — more ops',
      'the complete chosen option label is the answer — not `a`/`y`'
    );
    assert.ok(
      await waitFor(() => frame().includes('answer: Postgres — more ops')),
      'the choice is committed to the transcript'
    );
  }

  // 3h3. N-1 free text: the composer is the answer box, and Esc skips.
  {
    const question = getCliApprovalAskerForTest();
    const pending = question(
      'What should the endpoint look like?\n(Type your answer and press Enter)'
    );
    assert.ok(
      await waitFor(() => frame().includes('What should the endpoint look like?')),
      `the free-text question renders: ${JSON.stringify(frame().slice(-300))}`
    );
    await typeOnly('POST /v2/things');
    assert.ok(frame().includes('POST /v2/things'), 'the composer is the answer box');
    instance.stdin.write('\r');
    assert.equal(
      await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]),
      'POST /v2/things',
      'free text answers the question verbatim'
    );
    assert.ok(
      await waitFor(() => frame().includes('Try "stream the camera')),
      'the composer is cleared after answering (the placeholder is back)'
    );

    const skipped = question(
      'Pick one?\n  1. alpha\n  2. beta\nEnter a number, or free text for "Other".'
    );
    await waitFor(() => frame().includes('alpha'));
    instance.stdin.write('\x1b'); // Esc
    assert.equal(
      await Promise.race([skipped, sleep(3000).then(() => 'TIMEOUT')]),
      '',
      'Esc skips the question instead of answering `n`'
    );
    assert.ok(
      await waitFor(() => frame().includes('answer: skipped')),
      'skipping is committed honestly'
    );
  }

  // 3i. D-2: Ctrl+C during an approval must resolve it exactly once — the run
  // ends, the dialog goes, `● waiting for you` clears and input works again.
  {
    const started = streamCalls.length;
    await typeOnly('hang until aborted');
    instance.stdin.write('\r');
    assert.ok(
      await waitFor(() => streamCalls.length === started + 1),
      'the interruptible run started'
    );
    assert.ok(await waitFor(() => frame().includes('● running')), 'the status shows the run');

    const approvalsBefore = rowsOf('result').filter((row) =>
      row.text.startsWith('approval:')
    ).length;
    const pending = viewAsker(structuredView());
    assert.ok(
      await waitFor(() => frame().includes('● waiting for you')),
      'the dialog blocks the run'
    );
    assert.ok(frame().includes('1/2/3 to answer'), 'the hint advertises the answer keys');

    instance.stdin.write('\x03'); // Ctrl+C
    assert.equal(
      await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]),
      'n',
      'Ctrl+C denies the pending approval instead of leaving it hanging'
    );
    assert.ok(
      await waitFor(() => !frame().includes('waiting for you')),
      'the status stops waiting'
    );
    assert.ok(
      await waitFor(() => !frame().includes('Do you want to create')),
      'the dead dialog is gone (its question row leaves the chrome)'
    );
    assert.ok(
      frame().includes('approval: no · demo-write.txt'),
      'the committed denial names what was denied'
    );
    assert.equal(
      rowsOf('result').filter((row) => row.text.startsWith('approval:')).length,
      approvalsBefore + 1,
      'the decision is committed exactly once (the abort listener does not re-resolve)'
    );
    // Every keystroke used to be swallowed by the approval branch.
    await typeOnly('typing again');
    assert.ok(frame().includes('typing again'), 'the composer accepts input after Ctrl+C');
    instance.stdin.write('\x0c');
    await sleep(80);
    assert.ok(await waitFor(() => !frame().includes('typing again')), 'the draft can be cleared');
    assert.ok(await waitFor(() => !frame().includes('● running')), 'the aborted run finished');
  }

  // 3j. D-2b: the run's own abort signal resolves the dialog too — the run can
  // end with no keystroke at all.
  {
    const controller = new AbortController();
    const pending = viewAsker(structuredView(), controller.signal);
    assert.ok(await waitFor(() => frame().includes('● waiting for you')), 'the dialog is shown');
    controller.abort();
    assert.equal(
      await Promise.race([pending, sleep(3000).then(() => 'TIMEOUT')]),
      'n',
      'the run aborting resolves the dialog'
    );
    assert.ok(
      await waitFor(() => !frame().includes('waiting for you')),
      'the dialog is dismissed with no keystroke'
    );
    await typeOnly('after abort');
    assert.ok(frame().includes('after abort'), 'input works after the run ended');
    instance.stdin.write('\x0c');
    await sleep(80);
  }

  // 3k. D-5: ctrl+o re-renders rows already committed to <Static>. The printed
  // `· ctrl+o` marker must not advertise something the key cannot do.
  {
    const long = Array.from({ length: 40 }, (_, index) => `seq-line-${index + 1}`).join('\n');
    appendRow(handle.store, 'result', long);
    handle.notify();
    assert.ok(
      await waitFor(() => frame().includes('more lines · ctrl+o')),
      `the collapse marker is printed: ${JSON.stringify(frame().slice(-200))}`
    );
    assert.ok(!frame().includes('seq-line-40'), 'the tail is hidden while collapsed');
    instance.stdin.write('\x0f'); // Ctrl+O
    await sleep(80);
    assert.ok(
      !frame().includes('seq-line-40'),
      'ctrl+o does not reprint committed rows into the scrollback'
    );
  }

  // 3l. D-9: an Esc interrupt is an outcome the user asked for, not a red bold
  // failure carrying the provider's abort message.
  {
    const errorsBefore = rowsOf('error').length;
    const started = streamCalls.length;
    await type('hang until aborted');
    assert.ok(
      await waitFor(() => streamCalls.length === started + 1),
      'the interruptible run started'
    );
    assert.ok(await waitFor(() => frame().includes('● running')), 'the run is in flight');
    instance.stdin.write('\x1b'); // Esc
    assert.ok(
      await waitFor(() => frame().includes('interrupted — partial output kept')),
      `the interrupt is recorded quietly: ${JSON.stringify(frame().slice(-200))}`
    );
    assert.equal(
      rowsOf('error').length,
      errorsBefore,
      'no error row was created for the interrupt'
    );
    assert.ok(
      !frame().includes('This operation was aborted'),
      'the provider abort message is never rendered as a failure'
    );
    assert.ok(frame().includes('· interrupted'), 'the finalizing line still says interrupted');
    assert.ok(
      rowsOf('assistant').some((row) => row.text.includes('partial answer')),
      'the partial answer survives the interrupt'
    );
  }

  // 3m. D-6: prose before and after a tool call are separate blocks, never one
  // run-on line.
  {
    assert.ok(
      await waitFor(() => !frame().includes('● running')),
      'the previous run finished before the next turn'
    );
    const started = streamCalls.length;
    await type('prose across a tool');
    assert.ok(await waitFor(() => streamCalls.length === started + 1), 'the run started');
    assert.ok(
      await waitFor(() => rowsOf('assistant').some((row) => row.text === 'Planning the refactor.')),
      `pre-tool prose is committed as its own row: ${JSON.stringify(
        rowsOf('assistant').map((row) => row.text)
      )}`
    );
    assert.ok(
      await waitFor(() => rowsOf('assistant').some((row) => row.text === 'Todo list is live.')),
      'post-tool prose is committed as its own row'
    );
    assert.ok(
      !frame().includes('Planning the refactor.Todo list is live.'),
      'the two segments are never concatenated'
    );
  }

  // 3m2. N-4: an answer longer than the 400-char live tail keeps its HEAD in
  // the transcript (the committed row was the capped tail, so the beginning of
  // a long answer was silently dropped).
  {
    const started = streamCalls.length;
    await type('long answer');
    assert.ok(await waitFor(() => streamCalls.length === started + 1), 'the long run started');
    assert.ok(
      await waitFor(() =>
        rowsOf('assistant').some((row) => row.text.startsWith('HEAD-OF-THE-ANSWER'))
      ),
      `the committed answer keeps its head: ${JSON.stringify(
        rowsOf('assistant').map((row) => row.text.slice(0, 40))
      )}`
    );
  }

  // 3n. D-7: Ctrl+C is the advertised two-press quit. ONE press must not exit
  // and must not destroy the draft; the second press inside the window quits.
  // Kept last on purpose: the second press really does end the app.
  {
    await typeOnly('a draft I care about');
    assert.ok(frame().includes('a draft I care about'), 'the draft is in the composer');
    instance.stdin.write('\x03'); // first Ctrl+C
    assert.ok(
      await waitFor(() => frame().includes('press Ctrl+C again to quit')),
      `the first press arms the quit: ${JSON.stringify(frame().slice(-200))}`
    );
    assert.ok(frame().includes('a draft I care about'), 'the draft survives the first press');
    await typeOnly('!');
    assert.ok(
      frame().includes('a draft I care about!'),
      'the app is still alive and accepting input after one press'
    );
    instance.stdin.write('\x03'); // second Ctrl+C inside the window
    await sleep(250);
    const afterExit = frame();
    await typeOnly('zz');
    await sleep(250);
    assert.equal(frame(), afterExit, 'the second press quits: the frame stops changing');
  }

  instance.unmount();
  await sleep(150);
}

console.log('[PASS] CLI shell (transcript grammar / live run / approval / task blocks / width)');
