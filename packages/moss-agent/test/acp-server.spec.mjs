#!/usr/bin/env node
/**
 * ACP stdio server — host-neutral wire protocol over NDJSON JSON-RPC.
 * Tests the protocol logic with a fake agent + in-memory streams.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { runAcpStdioServer } from '../dist/cli/acp-server.js';

function fakeSessionStore() {
  const sessions = new Map();
  return {
    async replaceMessages(key, msgs) {
      sessions.set(key, msgs);
    },
    async exists(key) {
      return sessions.has(key);
    },
    async loadMessages(key) {
      return sessions.get(key) ?? [];
    },
    async appendMessage(key, msg) {
      sessions.set(key, [...(sessions.get(key) ?? []), msg]);
    },
    async listSessions() {
      return [];
    },
    async deleteSession(key) {
      sessions.delete(key);
    },
  };
}

/** Minimal fake agent: config.sessionStore + streamChat yielding fixed events. */
function fakeAgent(eventsForPrompt) {
  const graph = { id: 'task-1', revision: 1, status: 'paused' };
  return {
    config: { sessionStore: fakeSessionStore() },
    tasks: {
      list: () => [graph],
      inspect: () => graph,
      resume: () => ({ ...graph, revision: 2, status: 'running' }),
      retry: (_taskId, nodeId) => ({ ...graph, retriedNodeId: nodeId }),
      stop: () => ({ ...graph, revision: 2, status: 'cancelled' }),
    },
    async *streamChat(sessionId, prompt, opts) {
      for (const e of eventsForPrompt(prompt)) {
        if (opts?.abortSignal?.aborted) break;
        yield e;
      }
    },
  };
}

async function runServer(agent, requests) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = runAcpStdioServer(agent, { input, output });
  for (const r of requests) input.write(JSON.stringify(r) + '\n');
  input.end();
  await done;
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('initialize returns capabilities + server info', async () => {
  const out = await runServer(
    fakeAgent(() => []),
    [{ jsonrpc: '2.0', id: 1, method: 'initialize' }]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.equal(out[0].result.serverInfo.name, 'moss');
  assert.equal(out[0].result.capabilities.streaming, true);
});

test('session/new returns a sessionId', async () => {
  const out = await runServer(
    fakeAgent(() => []),
    [{ jsonrpc: '2.0', id: 2, method: 'session/new' }]
  );
  assert.equal(out[0].id, 2);
  assert.ok(out[0].result.sessionId.startsWith('cli-'), 'sessionId is a cli- key');
});

test('ACP exposes the same durable task identity and control actions', async () => {
  const out = await runServer(
    fakeAgent(() => []),
    [
      { jsonrpc: '2.0', id: 1, method: 'task/list' },
      { jsonrpc: '2.0', id: 2, method: 'task/inspect', params: { taskId: 'task-1' } },
      { jsonrpc: '2.0', id: 3, method: 'task/resume', params: { taskId: 'task-1' } },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'task/retry',
        params: { taskId: 'task-1', nodeId: 'node-1' },
      },
    ]
  );
  assert.equal(out.find((message) => message.id === 1).result.tasks[0].id, 'task-1');
  assert.equal(out.find((message) => message.id === 2).result.revision, 1);
  assert.equal(out.find((message) => message.id === 3).result.status, 'running');
  assert.equal(out.find((message) => message.id === 4).result.retriedNodeId, 'node-1');
});

test('session/prompt streams text + tool notifications and returns the final text', async () => {
  const events = (prompt) => [
    { type: 'text_delta', delta: 'Hello ' },
    { type: 'text_delta', delta: 'world' },
    { type: 'tool_start', toolName: 'read_file', toolCallId: 't1', input: { path: 'a.ts' } },
    {
      type: 'tool_end',
      toolName: 'read_file',
      toolCallId: 't1',
      result: 'file contents',
      isError: false,
    },
    { type: 'turn_end', turn: 1, stopReason: 'end_turn' },
  ];
  const out = await runServer(fakeAgent(events), [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'session/new' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'cli-x', prompt: 'hi' },
    },
  ]);
  // initialize + session/new + (2 text deltas + 2 toolCall notifications) + final result
  assert.ok(out.length >= 5);
  const textDeltas = out.filter((m) => m.method === 'session/delta' && m.params.type === 'text');
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].params.delta, 'Hello ');
  const toolCalls = out.filter((m) => m.method === 'session/toolCall');
  assert.equal(toolCalls.length, 2); // start + end
  assert.equal(toolCalls[0].params.state, 'start');
  assert.equal(toolCalls[1].params.state, 'end');
  const final = out.find((m) => m.id === 3);
  assert.ok(final, 'final result has the request id');
  assert.equal(final.result.text, 'Hello world');
  assert.equal(final.result.stopReason, 'end_turn');
});

test('session/cancel aborts the active prompt', async () => {
  // Events that yield forever until aborted.
  const events = function* () {
    let i = 0;
    while (true) yield { type: 'text_delta', delta: `chunk${i++} ` };
  };
  // fakeAgent expects eventsForPrompt(prompt) → iterable; use a generator factory.
  const agent = {
    config: { sessionStore: fakeSessionStore() },
    async *streamChat(sessionId, prompt, opts) {
      for (const e of events()) {
        if (opts?.abortSignal?.aborted) break;
        yield e;
      }
    },
  };
  const out = await runServer(agent, [
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'cli-x', prompt: 'hi' },
    },
    { jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId: 'cli-x' } },
  ]);
  const cancel = out.find((m) => m.id === 4);
  assert.equal(cancel.result.cancelled, true, 'cancel reports true');
});

test('unknown method returns a method-not-found error', async () => {
  const out = await runServer(
    fakeAgent(() => []),
    [{ jsonrpc: '2.0', id: 9, method: 'bogus/method' }]
  );
  assert.equal(out[0].id, 9);
  assert.ok(out[0].error, 'error object returned');
  assert.equal(out[0].error.code, -32601);
});

test('malformed JSON returns a parse error with id null', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = runAcpStdioServer(
    fakeAgent(() => []),
    { input, output }
  );
  input.write('not-json\n');
  input.end();
  await done;
  const out = chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(out[0].id, null);
  assert.equal(out[0].error.code, -32700);
});
