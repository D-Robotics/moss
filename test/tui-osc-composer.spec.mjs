import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackTempDir } from './helpers/temp-home.mjs';
const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-osc-composer-')));
process.env.MOSS_CONFIG_DIR = path.join(root, 'cfg');
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';
process.env.LANG = 'C';
const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
const { render } = await import('ink-testing-library');
const React = await import('react');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail('composer condition did not settle within original 5s');
}
const submitted = [];
let runningSignal;
let releaseRun;
const agent = {
  async *streamChat(_session, message, options) {
    submitted.push(message);
    if (message === 'running') {
      runningSignal = options.abortSignal;
      yield { type: 'text_delta', delta: 'working' };
      await new Promise((resolve) => {
        releaseRun = resolve;
      });
    }
    yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
  },
  steer: () => null,
  asyncTasks: { list: () => [] },
  config: {
    model: 'osc-spec',
    contextTokens: 100000,
    sessionStore: { loadMessages: async () => [] },
  },
  tools: { getAll: () => [], getNames: () => [], size: 0 },
};
const listeners = new Set();
const handle = {
  store: createTuiStore(),
  notify() {
    for (const fn of listeners) fn();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const runtime = new TaskRuntime({ workspaceDir: root });
const instance = render(
  React.createElement(TuiAppRoot, {
    options: { agent, workspaceDir: root, model: 'osc-spec' },
    handle,
    runtime,
  })
);
try {
  await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner'));
  for (const [edit, expected] of [
    ['', 'abc]'],
    ['\x7f', 'abc'],
    ['\x1b[D' + 'X', 'abcX]'],
  ]) {
    for (const ch of 'abc]') {
      instance.stdin.write(ch);
      await sleep(20);
    }
    if (edit) {
      if (edit.endsWith('X')) {
        instance.stdin.write('\x1b[D');
        await sleep(20);
        instance.stdin.write('X');
      } else instance.stdin.write(edit);
      await sleep(20);
    }
    const count = submitted.length;
    instance.stdin.write('\r');
    await waitFor(() => submitted.length > count);
    assert.equal(
      submitted[count],
      expected,
      'held literal ] must be applied before submit/delete/left-arrow'
    );
    await waitFor(() => !runtime.getLiveState().running);
    await runtime.endRun();
    await sleep(20);
  }
  instance.stdin.write('running');
  await sleep(30);
  instance.stdin.write('\r');
  await waitFor(() => runningSignal && releaseRun);
  instance.stdin.write(']11;rgb:1/2/3');
  await sleep(30);
  instance.stdin.write('\x1b');
  await sleep(30);
  assert.equal(runningSignal.aborted, false, 'the OSC ST escape must not cancel the active run');
  instance.stdin.write('\\');
  await sleep(30);
  instance.stdin.write('\x1b');
  await waitFor(() => runningSignal.aborted);
  releaseRun();
  releaseRun = undefined;
  await waitFor(() => !runtime.getLiveState().running);
  await runtime.endRun();
  console.log(
    '[PASS] real TUI literal controls and split OSC ST preserve active-run cancellation semantics'
  );
} finally {
  releaseRun?.();
  await waitFor(() => !runtime.getLiveState().running);
  instance.unmount();
  await runtime.endRun();
}
