#!/usr/bin/env node
/**
 * A model switch must rebuild the system prompt. The persona is built once at
 * startup; `/model`, the REPL switch, and setup-save all go through
 * MossAgent.switchModel, which calls identityFactory so the next request names
 * the new model in both the English and Chinese lines.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { resolveSoulIdentity } from '../dist/core/agent/soul.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createCliProvider } from '../dist/cli/providers.js';
import { createModelInfoTool } from '../dist/cli/model-info-tool.js';

const STARTUP = 'startup-qwen-x';
const SWITCHED = 'switched-kimi-y';

function enLine(model) {
  return `You currently run on the \`${model}\` model.`;
}

function zhLine(model) {
  return `你当前运行在 \`${model}\` 模型上。`;
}

function systemText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find((message) => message?.role === 'system');
  if (!system) return '';
  if (typeof system.content === 'string') return system.content;
  if (Array.isArray(system.content)) {
    return system.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function assertPromptNames(system, model, stale) {
  assert.ok(
    system.includes(enLine(model)),
    `EN line should name ${model}:\n${system.slice(0, 500)}`
  );
  assert.ok(
    system.includes(zhLine(model)),
    `ZH line should name ${model}:\n${system.slice(0, 500)}`
  );
  assert.ok(!system.includes(stale), `system prompt still contains ${stale}`);
  assert.ok(!system.includes(enLine(stale)), `EN line still names ${stale}`);
  assert.ok(!system.includes(zhLine(stale)), `ZH line still names ${stale}`);
}

function startStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        if (raw) body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const url = req.url ?? '';
      if (req.method === 'GET' && url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: STARTUP }, { id: SWITCHED }] }));
        return;
      }
      if (req.method === 'POST' && url.includes('/chat/completions')) {
        const requested = typeof body.model === 'string' ? body.model : '';
        requests.push({ model: requested, system: systemText(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-model-switch',
            model: requested ? `gateway-${requested}` : '',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'STUB_REPLY_OK' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 2 },
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        requests,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function providerFor(model, baseUrl) {
  return createCliProvider({
    provider: 'openai-compatible',
    apiKey: 'sk-test-model-switch',
    model,
    baseUrl,
  });
}

async function chatSwitchChat({ workspaceDir, label }) {
  const stub = await startStub();
  const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
  const store = new InMemorySessionStore();
  const sessionKey = `switch-${label}`;
  const agent = new MossAgent({
    llmProvider: providerFor(STARTUP, baseUrl),
    sessionStore: store,
    model: STARTUP,
    provider: 'openai-compatible',
    baseUrl,
    usingBundledDefault: false,
    workspaceDir,
    enableSteering: false,
    baseSystemPrompt: resolveSoulIdentity({
      workspaceDir,
      model: STARTUP,
      usingBundledDefault: false,
    }),
  });
  agent.config.identityFactory = (model) =>
    resolveSoulIdentity({
      workspaceDir,
      model,
      usingBundledDefault: agent.config.usingBundledDefault,
    });
  const modelTool = createModelInfoTool({
    provider: () => agent.config.llmProvider,
    config: () => ({
      model: agent.config.model,
      baseUrl: agent.config.baseUrl,
      usingBundledDefault: agent.config.usingBundledDefault,
    }),
    getReportedModel: () => agent.reportedModel(),
  });

  const usageModels = [];
  const servedModels = [];
  try {
    for await (const event of agent.streamChat(sessionKey, 'which model are you')) {
      if (event.type === 'llm_usage') {
        if (event.model) usageModels.push(event.model);
        if (event.servedModel) servedModels.push(event.servedModel);
      }
    }
    assert.equal(stub.requests.length, 1, `${label}: startup chat should be one request`);
    assert.equal(stub.requests[0].model, STARTUP, `${label}: request 1 model`);
    assertPromptNames(stub.requests[0].system, STARTUP, SWITCHED);
    assert.equal(usageModels[0], STARTUP, `${label}: usage.model stays the configured name`);
    assert.equal(
      servedModels[0],
      `gateway-${STARTUP}`,
      `${label}: servedModel records the gateway id`
    );

    agent.switchModel({
      model: SWITCHED,
      provider: 'openai-compatible',
      baseUrl,
      llmProvider: providerFor(SWITCHED, baseUrl),
      usingBundledDefault: false,
    });
    assertPromptNames(agent.buildSystemPrompt(), SWITCHED, STARTUP);
    const between = await modelTool.execute({ input: {} });
    assert.match(between, new RegExp(SWITCHED));
    assert.doesNotMatch(between, /gateway reported/);
    assert.equal(agent.reportedModel(), undefined, 'switch clears the previous gateway model');

    for await (const event of agent.streamChat(sessionKey, 'which model are you now')) {
      if (event.type === 'llm_usage') {
        if (event.model) usageModels.push(event.model);
        if (event.servedModel) servedModels.push(event.servedModel);
      }
    }
    assert.equal(stub.requests.length, 2, `${label}: switch should not add a hidden request`);
    assert.equal(stub.requests[1].model, SWITCHED, `${label}: request 2 model`);
    assertPromptNames(stub.requests[1].system, SWITCHED, STARTUP);
    assert.equal(usageModels[1], SWITCHED);
    assert.equal(servedModels[1], `gateway-${SWITCHED}`);

    const reported = await modelTool.execute({ input: {} });
    assert.match(
      reported,
      /configured switched-kimi-y, gateway reported gateway-switched-kimi-y/,
      reported
    );
    const assistants = (await store.loadMessages(sessionKey)).filter(
      (message) => message.role === 'assistant'
    );
    assert.equal(assistants.at(-1)?.model, `gateway-${SWITCHED}`);
    assert.equal(assistants[0]?.model, `gateway-${STARTUP}`);
  } finally {
    await agent.close();
    await stub.close();
  }
}

{
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-default-'));
  await chatSwitchChat({ workspaceDir, label: 'default-soul' });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  console.log('✓ default soul: switchModel rebuilds EN and ZH model lines');
}

{
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-soul-'));
  fs.mkdirSync(path.join(workspaceDir, '.moss'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.moss', 'soul.md'),
    'You are Custom Board Agent.\n',
    'utf8'
  );
  await chatSwitchChat({ workspaceDir, label: 'workspace-soul' });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  console.log('✓ workspace soul.md: footer names the switched model');
}

{
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-prepend-'));
  fs.mkdirSync(path.join(workspaceDir, '.moss'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.moss', 'soul.md'),
    '---\nmode: prepend\n---\nExtra persona layer.\n',
    'utf8'
  );
  await chatSwitchChat({ workspaceDir, label: 'prepend-soul' });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  console.log('✓ prepend soul: identity and footer name the switched model');
}

// ─── TUI /model handler ──────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 8000) {
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

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-cfg-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-model-switch-tui-'));
  const previousConfigDir = process.env.MOSS_CONFIG_DIR;
  const previousBundled = process.env.MOSS_NO_BUNDLED_DEFAULT;
  process.env.MOSS_CONFIG_DIR = configDir;
  process.env.MOSS_NO_BUNDLED_DEFAULT = '1';
  process.env.LC_ALL = 'C';
  process.env.LANG = 'C';

  const stub = await startStub();
  const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      model: STARTUP,
      baseUrl,
      apiKey: 'sk-test-model-switch',
    }),
    'utf8'
  );

  const { TuiAppRoot } = await import('../dist/cli/tui/app.js');
  const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
  const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');

  const store = new InMemorySessionStore();
  const sessionKey = 'tui-model-switch';
  const agent = new MossAgent({
    llmProvider: providerFor(STARTUP, baseUrl),
    sessionStore: store,
    model: STARTUP,
    provider: 'openai-compatible',
    baseUrl,
    usingBundledDefault: false,
    workspaceDir,
    enableSteering: false,
    identityFactory: (model) =>
      resolveSoulIdentity({
        workspaceDir,
        model,
        usingBundledDefault: false,
      }),
  });
  const listeners = new Set();
  const handle = {
    store: createTuiStore(),
    notify: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const runtime = new TaskRuntime({ workspaceDir });
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: { agent, workspaceDir, model: STARTUP, sessionKey },
      handle,
      runtime,
    })
  );

  try {
    await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner'));
    await type(instance, 'hello from the startup model');
    const first = await waitFor(
      () => stub.requests.length >= 1 && instance.lastFrame().includes('STUB_REPLY_OK')
    );
    assert.ok(first, `startup chat did not finish: ${instance.lastFrame().slice(-400)}`);
    assert.equal(stub.requests[0].model, STARTUP);
    assertPromptNames(stub.requests[0].system, STARTUP, SWITCHED);

    await type(instance, `/model ${SWITCHED} --custom`);
    const switched = await waitFor(() => agent.config.model === SWITCHED);
    assert.ok(switched, ` /model did not switch: ${instance.lastFrame().slice(-400)}`);
    assertPromptNames(agent.buildSystemPrompt(), SWITCHED, STARTUP);
    const frame = await waitFor(() => instance.lastFrame().includes(SWITCHED));
    assert.ok(frame, `status row did not follow ${SWITCHED}: ${instance.lastFrame().slice(-300)}`);

    await type(instance, 'hello after the switch');
    const second = await waitFor(() => stub.requests.length >= 2);
    assert.ok(second, `second chat missing: ${JSON.stringify(stub.requests.map((r) => r.model))}`);
    const chat = stub.requests.filter((request) => request.system);
    assert.equal(chat.at(-1).model, SWITCHED);
    assertPromptNames(chat.at(-1).system, SWITCHED, STARTUP);
  } finally {
    instance.unmount();
    await sleep(100);
    await agent.close();
    await stub.close();
    if (previousConfigDir === undefined) delete process.env.MOSS_CONFIG_DIR;
    else process.env.MOSS_CONFIG_DIR = previousConfigDir;
    if (previousBundled === undefined) delete process.env.MOSS_NO_BUNDLED_DEFAULT;
    else process.env.MOSS_NO_BUNDLED_DEFAULT = previousBundled;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  console.log('✓ TUI /model handler rebuilds the system prompt');
}

console.log('[PASS] model-switch-system-prompt');
