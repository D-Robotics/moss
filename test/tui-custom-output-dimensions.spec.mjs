import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiAppRoot } from '../dist/cli/tui/app.js';
import { createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { TaskRuntime } from '../dist/core/task-runtime/runtime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-custom-output-'));
const runtime = new TaskRuntime({ workspaceDir });
const listeners = new Set();
const handle = {
  store: createTuiStore(),
  notify() {
    for (const listener of listeners) listener();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const agent = {
  asyncTasks: { list: () => [] },
  // eslint-disable-next-line require-yield
  async *streamChat() {
    throw new Error('the dimensions spec never starts a run');
  },
};

const nativeExecFileSync = childProcess.execFileSync;
let terminalProbes = 0;
childProcess.execFileSync = function (...args) {
  if (/(?:^|[/\\])tput(?:\.exe)?$/.test(String(args[0]))) terminalProbes += 1;
  return Reflect.apply(nativeExecFileSync, this, args);
};
syncBuiltinESMExports();
let instance;
try {
  instance = render(
    React.createElement(TuiAppRoot, {
      options: { agent, workspaceDir, model: 'dimensions-model', version: '0.27.0' },
      handle,
      runtime,
    })
  );
  await sleep(50);
  const probesAfterMount = terminalProbes;
  const framesAfterMount = instance.frames.length;
  for (const listener of listeners) listener();
  await sleep(50);
  console.log(JSON.stringify({ probesAfterMount, terminalProbes }));
  assert.ok(instance.frames.length > framesAfterMount, 'the actual Ink tree rerendered');
  assert.equal(terminalProbes, probesAfterMount, 'later Ink commits do not launch tput');
  assert.equal(instance.stdout.columns, 100, 'the actual custom sink width is preserved');
  assert.equal(instance.stdout.rows, 24, 'missing rows use the existing Ink fallback');
  assert.notEqual(instance.stdout.isTTY, true, 'the custom sink is not made into a TTY');
  instance.unmount();
  await sleep(30);
  assert.equal(Object.hasOwn(instance.stdout, 'rows'), false, 'unmount removes its fallback');
} finally {
  instance?.unmount();
  instance?.cleanup();
  childProcess.execFileSync = nativeExecFileSync;
  syncBuiltinESMExports();
}

const { installNonTtyOutputDimensions } = await import('../dist/cli/tui/output-dimensions.js');
const missing = { columns: 100 };
const release = installNonTtyOutputDimensions(missing);
assert.equal(missing.columns, 100);
assert.equal(missing.rows, 24);
release();
assert.equal(Object.hasOwn(missing, 'rows'), false);

const empty = {};
const releaseEmpty = installNonTtyOutputDimensions(empty);
assert.deepEqual([empty.columns, empty.rows], [80, 24]);
releaseEmpty();
assert.deepEqual(Object.getOwnPropertyNames(empty), []);

const hostUpdated = {};
const releaseUpdated = installNonTtyOutputDimensions(hostUpdated);
hostUpdated.rows = 24; // Even an equal host-assigned dimension belongs to the host.
Object.defineProperty(hostUpdated, 'columns', { get: () => 120, configurable: true });
releaseUpdated();
assert.equal(hostUpdated.rows, 24);
assert.equal(hostUpdated.columns, 120);

const invalid = { columns: 0, rows: undefined };
const prior = Object.getOwnPropertyDescriptors(invalid);
installNonTtyOutputDimensions(invalid)();
assert.deepEqual(Object.getOwnPropertyDescriptors(invalid), prior);

const tty = { isTTY: true };
assert.equal(installNonTtyOutputDimensions(tty), undefined);
assert.deepEqual(tty, { isTTY: true });
const complete = { columns: 120, rows: 40 };
assert.equal(installNonTtyOutputDimensions(complete), undefined);
assert.deepEqual(complete, { columns: 120, rows: 40 });
const processDimensions = Object.getOwnPropertyDescriptors(process.stdout);
assert.equal(installNonTtyOutputDimensions(process.stdout), undefined);
assert.deepEqual(Object.getOwnPropertyDescriptors(process.stdout), processDimensions);
const readonly = Object.freeze({ columns: 100 });
assert.doesNotThrow(() => installNonTtyOutputDimensions(readonly));
assert.deepEqual(readonly, { columns: 100 });
const locked = Object.defineProperty({}, 'rows', { value: undefined, writable: false });
assert.doesNotThrow(() => installNonTtyOutputDimensions(locked)?.());
assert.equal(locked.rows, undefined);
let hostSetterValue;
const accessor = Object.defineProperty({ columns: 100 }, 'rows', {
  get: () => hostSetterValue,
  set: (value) => {
    hostSetterValue = value;
  },
  configurable: true,
});
const hostAccessor = Object.getOwnPropertyDescriptor(accessor, 'rows');
assert.equal(installNonTtyOutputDimensions(accessor), undefined);
accessor.rows = 24;
assert.equal(hostSetterValue, 24, 'the existing host setter still receives updates');
assert.deepEqual(Object.getOwnPropertyDescriptor(accessor, 'rows'), hostAccessor);
const inheritedAccessor = Object.assign(Object.create(accessor), { columns: 100 });
hostSetterValue = undefined;
assert.equal(installNonTtyOutputDimensions(inheritedAccessor), undefined);
inheritedAccessor.rows = 24;
assert.equal(hostSetterValue, 24, 'an inherited host setter still receives updates');
assert.equal(Object.hasOwn(inheritedAccessor, 'rows'), false);
const inheritedReadonly = Object.assign(
  Object.create(Object.defineProperty({}, 'rows', { value: undefined, writable: false })),
  { columns: 100 }
);
assert.equal(installNonTtyOutputDimensions(inheritedReadonly), undefined);
assert.equal(Object.hasOwn(inheritedReadonly, 'rows'), false);
const emptyAccessor = Object.defineProperty({ columns: 100 }, 'rows', {
  get: undefined,
  set: undefined,
  configurable: true,
});
const emptyDescriptor = Object.getOwnPropertyDescriptor(emptyAccessor, 'rows');
assert.equal(installNonTtyOutputDimensions(emptyAccessor), undefined);
assert.deepEqual(Object.getOwnPropertyDescriptor(emptyAccessor, 'rows'), emptyDescriptor);
const inheritedEmptyAccessor = Object.assign(Object.create(emptyAccessor), { columns: 100 });
assert.equal(installNonTtyOutputDimensions(inheritedEmptyAccessor), undefined);
assert.equal(Object.hasOwn(inheritedEmptyAccessor, 'rows'), false);
const nonEnumerable = Object.defineProperty({ columns: 100 }, 'rows', {
  value: 0,
  configurable: true,
  writable: true,
});
const releaseNonEnumerable = installNonTtyOutputDimensions(nonEnumerable);
nonEnumerable.rows = 24;
releaseNonEnumerable();
assert.equal(Object.getOwnPropertyDescriptor(nonEnumerable, 'rows').enumerable, false);
assert.equal(nonEnumerable.rows, 24);
console.log('[PASS] custom non-TTY dimensions, native probe, cleanup and host/TTY boundaries');
