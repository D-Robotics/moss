#!/usr/bin/env node
/**
 * `/model` lists the catalog, Enter keeps the switch in this session, and
 * `d` / `/model save` writes the default. The status row shows the active model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';
process.env.LC_ALL = 'C';
process.env.LANG = 'C';

const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
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
  await sleep(30);
}

function mockAgent() {
  const config = {
    model: 'spec-model',
    contextTokens: 100_000,
    llmProvider: { id: 'spec-model' },
    sessionStore: { loadMessages: async () => [] },
  };
  return {
    steer: () => null,
    asyncTasks: { list: () => [] },
    config,
    switchModel(next) {
      config.model = next.model;
      if (next.provider !== undefined) config.provider = next.provider;
      if (next.baseUrl !== undefined) config.baseUrl = next.baseUrl;
      config.llmProvider = next.llmProvider;
      if (next.usingBundledDefault !== undefined) {
        config.usingBundledDefault = next.usingBundledDefault;
      }
      if (typeof config.identityFactory === 'function') {
        config.baseSystemPrompt = config.identityFactory(next.model);
      }
    },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async *streamChat() {
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
}

function mount(agent) {
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-ws-')),
  });
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent, workspaceDir: '/tmp/ws', model: 'spec-model' },
      handle,
      runtime,
    })
  );
  return { instance, handle };
}

const configPath = path.join(configDir, 'config.json');
const readModel = () => {
  if (!fs.existsSync(configPath)) return undefined;
  return JSON.parse(fs.readFileSync(configPath, 'utf8')).model;
};

{
  const agent = mockAgent();
  const { instance, handle } = mount(agent);
  await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner'));
  assert.match(instance.lastFrame(), /spec-model/, 'the status row shows the active model');
  await type(instance, '/model');
  const opened = await waitFor(() => instance.lastFrame().includes('d save as default'));
  assert.ok(opened, `picker opened: ${instance.lastFrame().slice(-400)}`);
  assert.match(instance.lastFrame(), /spec-model/);
  instance.stdin.write('d');
  const saved = await waitFor(() =>
    handle.store.rows
      .map((row) => row.text)
      .join('\n')
      .includes('saved spec-model')
  );
  assert.ok(saved, `save note missing: ${handle.store.rows.map((row) => row.text).join('\n')}`);
  assert.equal(readModel(), 'spec-model');
  assert.equal(agent.config.model, 'spec-model');
  const providerBefore = agent.config.llmProvider;
  await type(instance, '/model spec-two --custom');
  const switched = await waitFor(() => agent.config.model === 'spec-two');
  assert.ok(switched, 'session model changed');
  assert.notEqual(agent.config.llmProvider, providerBefore);
  assert.equal(readModel(), 'spec-model', 'a session switch does not rewrite the default');
  const frame = await waitFor(() => instance.lastFrame().includes('spec-two'));
  assert.ok(frame, `status row follows spec-two: ${instance.lastFrame().slice(-300)}`);
  instance.unmount();
  await sleep(100);
}

{
  const agent = mockAgent();
  const { instance, handle } = mount(agent);
  await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner'));
  await type(instance, '/model save spec-saved --custom');
  const noted = await waitFor(() =>
    handle.store.rows
      .map((row) => row.text)
      .join('\n')
      .includes('saved spec-saved')
  );
  assert.ok(noted, handle.store.rows.map((row) => row.text).join('\n'));
  assert.equal(agent.config.model, 'spec-saved');
  assert.equal(readModel(), 'spec-saved');
  const raw = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(raw, /sk-/);
  instance.unmount();
  await sleep(100);
}

console.log('[PASS] /model session switch and default');
