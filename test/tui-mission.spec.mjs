#!/usr/bin/env node
/**
 * Mission Control TUI (v0.21 redo): task-first layout, state-first canvas,
 * contextual device panel, transcript demotion, overlays (task switcher /
 * history / resume / evidence / deployments / action menu / failure-repair /
 * help), and the two responsive breakpoints (wide 3-pane / standard 2-pane).
 * Pure projections from the shared TaskRuntime + component-level overlay
 * interactions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';
import {
  appendTaskRecord,
  appendEvidenceRecord,
  appendAcceptanceVerdict,
} from '../dist/core/task-runtime/artifacts.js';
import { appendDeploymentRecord } from '../dist/device/deployment.js';
import { computeLayout } from '../dist/cli/tui/layout.js';
import { renderCanvas, renderContextPanel, renderNavigator } from '../dist/cli/tui/panels.js';
import {
  actionMenuItems,
  HELP_COMMANDS,
  renderActionMenu,
  renderDeploymentInspector,
  renderEvidenceInspector,
  renderFailureRepair,
  renderHelp,
  renderTaskHistory,
  renderTaskSwitcher,
} from '../dist/cli/tui/overlays.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (lines) => lines.map((l) => l.text).join('\n');

// ─── workspace fixture: camera task passed after a repair, ROS task failed ──

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-mission-'));

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

// ─── 1. Task Navigator: state-first list, task kinds, results ───────────────

{
  const nav = renderNavigator({
    summaries: runtime.taskSummaries(),
    selectedTaskId: 'task_cam1',
    focusTaskId: 'task_cam1',
    width: 26,
    height: 12,
  });
  const joined = text(nav);
  assert.ok(joined.includes('TASKS (2)'), 'navigator lists task count');
  assert.ok(joined.includes('CAMERA'), 'camera kind visible');
  assert.ok(joined.includes('ROS'), 'ros kind visible');
  assert.ok(joined.includes('PASS'), 'accepted task shows PASS');
  assert.ok(/task_cam1|cam1|1 Cam/i.test(joined) || joined.includes('▸'), 'selection marker');
}

// ─── 2. Canvas: GOAL / PLAN / PROGRESS / FAILURE / REPAIR / VERIFICATION /
//        ACCEPTANCE all render; current action appears only live ────────────

{
  // Empty state teaches the interface: examples, workspace truth, keys.
  const empty = renderCanvas({
    summaries: [],
    width: 76,
    height: 14,
    detailExpanded: false,
    workspace: {
      device: 'not configured — set MOSS_DEVICE_HOST in .env',
      tasks: 0,
      evidence: 3,
      acceptance: 1,
    },
  });
  const emptyText = text(empty);
  assert.ok(emptyText.includes('EXAMPLES — ↑↓ select'), 'example loader hint');
  assert.ok(emptyText.includes('1 › Stream the camera'), 'example 1 listed');
  assert.ok(emptyText.includes('WORKSPACE'), 'workspace section');
  assert.ok(emptyText.includes('not configured'), 'device truth visible');
  assert.ok(emptyText.includes('3 evidence · 1 acceptance'), 'artifact counts');
  assert.ok(emptyText.includes('One intent → one task'), 'product sentence');
  assert.ok(!emptyText.includes('MISSION CONTROL'), 'no duplicate title inside panel');
  assert.ok(!emptyText.includes('TASKS: none yet'), 'no duplicate strip inside panel');
}

{
  const detail = runtime.taskDetail('task_cam1');
  assert.equal(detail.summary.state, 'COMPLETED');
  assert.equal(detail.summary.result, 'PASS');

  const canvas = renderCanvas({
    detail,
    summaries: runtime.taskSummaries(),
    selectedTaskId: 'task_cam1',
    width: 60,
    height: 40,
    detailExpanded: false,
  });
  const joined = text(canvas);
  for (const section of [
    'GOAL',
    'PLAN',
    'PROGRESS',
    'FAILURE / DIAGNOSIS',
    'REPAIR',
    'VERIFICATION',
    'ACCEPTANCE',
  ]) {
    assert.ok(joined.includes(section), `canvas renders ${section}`);
  }
  assert.ok(joined.includes('stream camera at 30 fps'), 'goal text present');
  assert.ok(joined.includes('deploy fps probe'), 'plan step present');
  assert.ok(joined.includes('31.5'), 'observed value present');
  assert.ok(joined.includes('PASS'), 'acceptance verdict present');
  assert.ok(joined.includes('execution detail'), 'transcript demoted to a teaser line');
  assert.ok(!joined.includes('NOW ▌'), 'no live action when the run is idle');

  // Live run: NOW line reflects the in-flight tool call.
  runtime.beginRun();
  runtime.applyEvent({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'c1',
    input: { command: 'fps_probe.sh' },
  });
  const liveCanvas = renderCanvas({
    detail: runtime.taskDetail('task_cam1'),
    summaries: runtime.taskSummaries(),
    selectedTaskId: 'task_cam1',
    width: 60,
    height: 40,
    detailExpanded: false,
  });
  assert.ok(text(liveCanvas).includes('NOW ▌ device ▸ fps_probe.sh'), 'current action live');
  await runtime.endRun(false);
}

// ─── 3. Context panel is task-kind aware (camera vs ros vs model vs nav) ────

{
  const cameraPanel = renderContextPanel({
    detail: runtime.taskDetail('task_cam1'),
    width: 34,
    height: 16,
  });
  const cameraText = text(cameraPanel);
  assert.ok(cameraText.includes('CONTEXT · CAMERA'), 'camera context header');
  assert.ok(cameraText.includes('Camera / FPS / Pipeline'), 'camera metric hint');
  assert.ok(cameraText.includes('rdk-x3'), 'device id present');
  assert.ok(cameraText.includes('camera_fps'), 'kind-filtered metric present');
  assert.ok(cameraText.includes('DEPLOYMENTS'), 'deployments section');
  assert.ok(cameraText.includes('fps_probe'), 'deployed artifact visible');

  const rosPanel = renderContextPanel({
    detail: runtime.taskDetail('task_ros2'),
    width: 34,
    height: 16,
  });
  assert.ok(text(rosPanel).includes('Nodes / Topics / Runtime'), 'ros metric hint');

  for (const [kind, hint] of [
    ['model', 'Model / Latency / Memory / FPS'],
    ['navigation', 'Position / Velocity / Goal / Safety'],
  ]) {
    const summary = runtime.taskSummaries().find((s) => s.taskId === 'task_cam1');
    const synthetic = { ...summary, kind };
    const panel = renderContextPanel({
      detail: { ...runtime.taskDetail('task_cam1'), summary: synthetic },
      width: 40,
      height: 16,
    });
    assert.ok(text(panel).includes(hint), `${kind} hint`);
  }
}

// ─── 4. Overlays: switcher / history / evidence / deployments / action menu /
//        failure-repair all render from the shared runtime ──────────────────

{
  const switcher = renderTaskSwitcher(runtime.taskSummaries(), 0, 'task_cam1', 80, 20);
  const switcherText = text(switcher);
  assert.ok(switcherText.includes('TASK SWITCHER'), 'switcher title');
  assert.ok(switcherText.includes('task_cam1'), 'switcher lists task');
  assert.ok(switcherText.includes('stream camera'), 'switcher shows goal preview');

  const history = renderTaskHistory(runtime.taskDetail('task_cam1'), 80, 20);
  const historyText = text(history);
  assert.ok(historyText.includes('TASK HISTORY'), 'history title');
  assert.ok(historyText.includes('acceptance PASS'), 'history: acceptance');
  assert.ok(historyText.includes('camera_fps'), 'history: evidence');
  assert.ok(historyText.includes('deploy'), 'history: deployment');

  const evidence = renderEvidenceInspector(runtime.getArtifacts().evidence, 0, 80, 20);
  const evidenceText = text(evidence);
  assert.ok(evidenceText.includes('EVIDENCE INSPECTOR'), 'evidence title');
  assert.ok(evidenceText.includes('ev_1'), 'evidence record visible');
  assert.ok(evidenceText.includes('device_exec'), 'evidence source detail');

  const deployments = renderDeploymentInspector(runtime.getArtifacts().deployments, 0, 80, 24);
  const deployText = text(deployments);
  assert.ok(deployText.includes('DEPLOYMENT INSPECTOR'), 'deployments title');
  assert.ok(deployText.includes('fps_probe'), 'deployment artifact');
  assert.ok(deployText.includes('health: PASS'), 'health check outcome');

  const menu = renderActionMenu(0, 80, 20);
  const menuText = text(menu);
  assert.ok(menuText.includes('ACTION MENU'), 'menu title');
  for (const item of actionMenuItems()) {
    assert.ok(menuText.includes(item.label), `menu item: ${item.label}`);
  }

  const help = renderHelp(80, 40);
  const helpText = text(help);
  assert.ok(helpText.includes('HELP — KEYS & COMMANDS'), 'help title');
  assert.ok(helpText.includes('Ctrl+T H E'), 'help lists the global keys');
  assert.ok(helpText.includes('this help'), 'help advertises its own key');
  assert.ok(helpText.includes('Esc close'), 'help advertises how to close');
  for (const command of HELP_COMMANDS) {
    assert.ok(helpText.includes(command), `help lists command: ${command}`);
  }

  // The common 24-row terminal must show the whole reference: a help screen
  // that elides most of its own command list is not help.
  const helpTypical = text(renderHelp(80, 15));
  for (const command of HELP_COMMANDS) {
    assert.ok(helpTypical.includes(command), `24-row help still lists ${command}`);
  }
  assert.ok(!helpTypical.includes('more · Esc close'), '24-row help elides nothing');

  // Narrower/shorter panes may elide, but never silently: the title says how
  // much was dropped and the help key is still advertised.
  const helpShort = renderHelp(80, 8);
  const helpShortText = text(helpShort);
  assert.equal(helpShort.length, 8, 'help never exceeds the pane height');
  assert.ok(helpShortText.includes('HELP — KEYS & COMMANDS'), 'short help keeps its title');
  assert.ok(helpShortText.includes('Esc close'), 'short help keeps its close hint');
  assert.ok(/… \d+ more/.test(helpShortText), 'short help elides honestly');

  const failureRepair = renderFailureRepair(runtime.taskDetail('task_cam1'), 80, 20);
  const frText = text(failureRepair);
  assert.ok(frText.includes('FAILURE / REPAIR'), 'failure-repair title');
  assert.ok(frText.includes('camera_fps'), 'failure item listed');
  assert.ok(frText.includes('1 re-measurement'), 'repair cycle listed');
  assert.ok(frText.includes('latest acceptance: PASS'), 'latest verdict');
}

// ─── 5. Layout breakpoints: wide 3 panes, standard 2 panes (IDE shell) ──────

{
  const wide = computeLayout(140, 40);
  assert.equal(wide.mode, 'wide');
  assert.ok(wide.showNavigator && wide.showContext);
  assert.equal(wide.navigatorWidth + wide.canvasWidth + wide.contextWidth + 2, 140);

  const std = computeLayout(80, 24);
  assert.equal(std.mode, 'standard');
  assert.ok(std.showNavigator && !std.showContext, 'two-pane shell at 80 cols');
  assert.equal(std.navigatorWidth + std.canvasWidth + 1, 80, 'nav + canvas fills the row');
  assert.equal(std.bodyHeight, 24 - 7, 'chrome budget: the key reference costs no permanent row');

  const small = computeLayout(55, 24);
  assert.equal(small.mode, 'standard');
  assert.ok(small.showNavigator, 'navigator survives narrow terminals');
  assert.ok(small.canvasWidth >= 18, 'canvas keeps a usable minimum');
}

// ─── 6. Component level: Ctrl+T opens the switcher, ↵ switches tasks ───────

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
  const { TuiAppRoot } = await import('../dist/cli/tui/app.js');

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
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent: {
          async *streamChat() {
            yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
          },
        },
        workspaceDir: ws,
      },
      handle,
      runtime,
    })
  );
  await sleep(200);

  instance.stdin.write('\x14'); // Ctrl+T → task switcher overlay
  let ok = await waitForFrame(instance, (frame) => frame.includes('TASK SWITCHER'));
  assert.ok(ok, `switcher overlay opens: ${JSON.stringify(instance.lastFrame().slice(0, 160))}`);

  instance.stdin.write('\x1b[A'); // ↑ → cursor on the second task
  await sleep(80);
  instance.stdin.write('\r'); // switch
  ok = await waitForFrame(instance, (frame) => frame.includes('Switched to task_'));
  assert.ok(ok, 'switching tasks answers with a notice');

  // Ctrl+E opens the evidence inspector from the same runtime.
  instance.stdin.write('\x05'); // Ctrl+E
  ok = await waitForFrame(instance, (frame) => frame.includes('EVIDENCE INSPECTOR'));
  assert.ok(ok, 'evidence inspector opens');
  instance.stdin.write('\x1b'); // Esc closes
  ok = await waitForFrame(instance, (frame) => !frame.includes('EVIDENCE INSPECTOR'));
  assert.ok(ok, 'Esc closes the overlay');

  // The key reference is discoverable from the bar, opens on `?` and closes
  // on Esc.
  assert.ok(instance.lastFrame().includes('? help'), 'status bar advertises the help key');
  instance.stdin.write('?');
  ok = await waitForFrame(instance, (frame) => frame.includes('HELP — KEYS & COMMANDS'));
  assert.ok(ok, `? opens help: ${JSON.stringify(instance.lastFrame().slice(0, 160))}`);
  instance.stdin.write('\x1b');
  ok = await waitForFrame(instance, (frame) => !frame.includes('HELP — KEYS & COMMANDS'));
  assert.ok(ok, 'Esc closes the help overlay');

  // A '?' typed into a goal is literal text, never a help request.
  instance.stdin.write('echo ?');
  await sleep(120);
  const typedFrame = instance.lastFrame();
  assert.ok(!typedFrame.includes('HELP — KEYS & COMMANDS'), '? inside a goal is literal');
  assert.ok(typedFrame.includes('echo ?'), 'the typed goal survives verbatim');

  instance.unmount();
  await sleep(150);
}

async function waitForFrame(instance, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(instance.lastFrame())) return true;
    await sleep(40);
  }
  return false;
}

console.log('[PASS] Mission Control TUI (task-first canvas/context/overlays/breakpoints)');
