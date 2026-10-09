#!/usr/bin/env node
/**
 * P1-2: a message typed during a run steers. Null from steer falls back to the
 * queue, which is drawn above the composer and recalled with Up.
 * P0-6: /clear during a run is rejected (Codex disables Clear mid-task).
 * P1-3: /stop during a run does not abort that run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-steer-config-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';

const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify() {
      for (const listener of listeners) listener();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(12);
  }
  instance.stdin.write('\r');
  await sleep(40);
}

function mount(agent) {
  const handle = liveHandle();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-steer-'));
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent,
        workspaceDir: workspace,
        listSessions: async () => [],
        mcpServers: [],
        listCheckpoints: () => [],
      },
      handle,
      runtime: new TaskRuntime({ workspaceDir: workspace }),
    })
  );
  return { instance, handle };
}

function agentWith(steerImpl) {
  const streamCalls = [];
  const steerCalls = [];
  const agent = {
    steer(sessionKey, text) {
      steerCalls.push({ sessionKey, text });
      return steerImpl(text);
    },
    asyncTasks: { list: () => [] },
    config: {
      model: 'spec-model',
      contextTokens: 1000,
      sessionStore: { loadMessages: async () => [] },
    },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async *streamChat(_sessionKey, message) {
      streamCalls.push(message);
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
  return { agent, streamCalls, steerCalls };
}

{
  const { agent, streamCalls, steerCalls } = agentWith(() => ({
    id: 'steer-1',
    prompt: '',
    delivery: 'steer',
    createdAt: Date.now(),
  }));
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  handle.store.run.running = true;
  await type(instance, 'be terse');
  assert.equal(steerCalls.length, 1, 'an in-flight message calls steer');
  assert.equal(steerCalls[0].text, 'be terse');
  assert.equal(streamCalls.length, 0, 'a steered message does not start another turn');
  assert.ok(
    handle.store.rows.some(
      (row) => row.kind === 'summary' && row.text.includes('queued: be terse')
    ),
    'the transcript echoes the steer'
  );
  instance.unmount();
  await sleep(80);
}

{
  const { agent, streamCalls, steerCalls } = agentWith(() => null);
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  handle.store.run.running = true;
  await type(instance, 'hold this');
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0].text, 'hold this');
  assert.equal(streamCalls.length, 0, 'a refused steer does not start a turn');
  assert.ok(
    await waitFor(() => instance.lastFrame().includes('queued 1. hold this')),
    `the queue is drawn above the composer: ${JSON.stringify(instance.lastFrame().slice(-400))}`
  );
  instance.stdin.write('\x1b[A');
  assert.ok(
    await waitFor(
      () =>
        instance.lastFrame().includes('hold this') &&
        !instance.lastFrame().includes('queued 1. hold this')
    ),
    'Up pulls the queued line back into the composer'
  );
  instance.unmount();
  await sleep(80);
}

{
  const { agent, streamCalls } = agentWith(() => null);
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  const before = handle.store.rows.length;
  handle.store.run.running = true;
  await type(instance, '/clear');
  assert.ok(
    await waitFor(() =>
      handle.store.rows.some((row) =>
        row.text.includes('a run is in flight — press Esc to interrupt it, then /clear')
      )
    ),
    '/clear during a run explains that it will not run'
  );
  assert.ok(
    !handle.store.rows.some((row) => row.text.includes('transcript cleared')),
    '/clear during a run does not wipe the transcript'
  );
  assert.ok(handle.store.rows.length >= before, 'existing rows stay');
  assert.equal(handle.store.run.running, true, 'rejecting /clear does not stop the run');
  assert.equal(streamCalls.length, 0);
  instance.unmount();
  await sleep(80);
}

{
  const { agent, streamCalls } = agentWith(() => null);
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  handle.store.run.running = true;
  await type(instance, '/stop');
  assert.ok(
    await waitFor(() =>
      handle.store.rows.some((row) => row.kind === 'tool' && row.text === 'Stop')
    ),
    '/stop still answers while a run is in flight'
  );
  assert.equal(handle.store.run.running, true, '/stop does not interrupt the foreground run');
  assert.equal(streamCalls.length, 0, '/stop does not start or replace the foreground turn');
  instance.unmount();
  await sleep(80);
}

{
  // A message queued while /goal's task run is in flight must be sent when
  // that run ends. The task path does not share the chat turn's drain.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const streamCalls = [];
  let calls = 0;
  const agent = {
    steer() {
      return null;
    },
    asyncTasks: { list: () => [] },
    config: {
      model: 'spec-model',
      contextTokens: 1000,
      sessionStore: { loadMessages: async () => [] },
    },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async *streamChat(_sessionKey, message) {
      streamCalls.push(message);
      calls += 1;
      if (calls === 1) await gate;
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  await type(instance, '/goal ship --accept "true"');
  assert.ok(
    await waitFor(() => streamCalls.length >= 1 && handle.store.run.running),
    'the goal run is in flight'
  );
  await type(instance, 'afterwards');
  release();
  assert.ok(
    await waitFor(() => streamCalls.includes('afterwards'), 15_000),
    `queued follow-up was not sent after the task (calls: ${JSON.stringify(streamCalls.map((m) => m.slice(0, 40)))})`
  );
  instance.unmount();
  await sleep(80);
}

{
  const { agent, streamCalls } = agentWith(() => null);
  let handed = false;
  agent.takeDeferredSteers = () => {
    if (handed) return [];
    handed = true;
    return ['do not drop me'];
  };
  const { instance, handle } = mount(agent);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  await type(instance, 'hello');
  assert.ok(
    await waitFor(() => streamCalls.includes('do not drop me')),
    'a steer that missed the run is sent as the next turn'
  );
  instance.unmount();
  await sleep(80);
}

console.log('[PASS] tui steer default');
