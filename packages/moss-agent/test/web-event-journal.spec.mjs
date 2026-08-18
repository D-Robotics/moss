#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizedWebFetch as fetch } from './web-authorized-fetch.mjs';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { TaskRunLedger } from '../dist/core/task-run/task-run-ledger.js';
import { MossWebEventJournal, parseMossWebEventCursor } from '../dist/web-ui/web-event-journal.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

function fakeAgent(streamChat, store = new InMemorySessionStore()) {
  return {
    config: { sessionStore: store, model: 'journal-model' },
    tools: { getNames: () => [] },
    plugins: {
      inspect: () => ({ generation: 0, plugins: [] }),
      listCommands: () => [],
      subscribe: () => () => {},
    },
    streamChat,
  };
}

test('Web event journal survives restart and validates run-scoped cursors', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss web journal 空格 '));
  const journalFile = path.join(tempDir, 'nested', 'events.jsonl');
  try {
    const first = new MossWebEventJournal(journalFile);
    first.append('run:windows-safe', 'session/a', { type: 'text', delta: 'one' });
    first.append('run:windows-safe', 'session/a', {
      type: 'retry',
      attempt: 2,
      error: 'retryable',
    });
    const reloaded = new MossWebEventJournal(journalFile);
    assert.deepEqual(
      reloaded.events('run:windows-safe', 1).map(({ seq, event }) => [seq, event.type]),
      [[2, 'retry']]
    );
    assert.equal(parseMossWebEventCursor('run:windows-safe', 'run:windows-safe:2'), 2);
    assert.equal(parseMossWebEventCursor('run:windows-safe', 'other-run:99'), 0);
    assert.equal(parseMossWebEventCursor('run:windows-safe', 'not-a-cursor'), 0);
    assert.equal(parseMossWebEventCursor('run:windows-safe', '2trailing-data'), 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Web stream journals rich events and replays them as SSE after Last-Event-ID', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-sse-'));
  const journalFile = path.join(tempDir, '.moss', 'events.jsonl');
  const store = new InMemorySessionStore();
  const agent = fakeAgent(async function* () {
    yield { type: 'text_delta', delta: 'first' };
    yield { type: 'retry', attempt: 1, error: 'temporary' };
    yield { type: 'compaction', summaryChars: 12, droppedMessages: 3 };
    yield { type: 'llm_usage', inputTokens: 20, outputTokens: 5, contextTokens: 100 };
    yield {
      type: 'working_context_checkpoint',
      status: 'active',
      reason: 'tool result',
      goal: 'finish',
      nextAction: 'verify',
    };
    yield {
      type: 'done',
      result: {
        response: 'first',
        toolCalls: [],
        toolResults: [],
        stopReason: 'end_turn',
      },
    };
  }, store);
  const taskRuns = new TaskRunLedger();
  const firstHost = await startMossWebServer(agent, {
    port: 0,
    taskRunLedger: taskRuns,
    eventJournalFile: journalFile,
  });
  let runId;
  try {
    const session = await fetch(`${firstHost.url}/api/sessions`, { method: 'POST' }).then(
      (response) => response.json()
    );
    const stream = await fetch(`${firstHost.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'journal this turn' }),
    }).then((response) => response.text());
    const events = stream
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map(({ type }) => type),
      ['run', 'text', 'retry', 'compaction', 'usage', 'context', 'done']
    );
    runId = events[0].run.id;
  } finally {
    await firstHost.close();
  }

  const secondHost = await startMossWebServer(agent, {
    port: 0,
    taskRunLedger: taskRuns,
    eventJournalFile: journalFile,
  });
  try {
    const replay = await fetch(`${secondHost.url}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { 'last-event-id': `${runId}:2` },
    });
    assert.match(replay.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await replay.text();
    assert.doesNotMatch(body, /"delta":"first"/);
    assert.match(body, /event: retry/);
    assert.match(body, /event: compaction/);
    assert.match(body, /event: usage/);
    assert.match(body, /event: context/);
    assert.match(body, /event: done/);
    assert.match(body, /id: 7/);
  } finally {
    await secondHost.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh discovers an active run and SSE remains attached through cancellation', async () => {
  const store = new InMemorySessionStore();
  const agent = fakeAgent(async function* (_sessionId, _prompt, options) {
    await new Promise((resolve) =>
      options.abortSignal.addEventListener('abort', resolve, { once: true })
    );
    yield {
      type: 'done',
      result: {
        response: '',
        toolCalls: [],
        toolResults: [],
        stopReason: 'aborted_by_user',
      },
    };
  }, store);
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    const session = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const pending = await fetch(`${web.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'keep running' }),
    });
    const active = await fetch(`${web.url}/api/sessions/${session.sessionId}/active-run`).then(
      (response) => response.json()
    );
    assert.equal(active.run.status, 'running');
    assert.ok(active.cursor >= 1);

    const replay = await fetch(`${web.url}${active.eventsUrl}?after=0`);
    const cancelled = await fetch(`${web.url}/api/sessions/${session.sessionId}/cancel`, {
      method: 'POST',
    }).then((response) => response.json());
    assert.equal(cancelled.cancelled, true);
    assert.match(await pending.text(), /"stopReason":"aborted_by_user"/);
    const replayBody = await replay.text();
    assert.match(replayBody, /event: run/);
    assert.match(replayBody, /event: done/);
  } finally {
    await web.close();
  }
});

test('host restart records an interrupted event instead of inventing completion', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-interrupted-'));
  const journalFile = path.join(tempDir, 'events.jsonl');
  const taskRuns = new TaskRunLedger();
  taskRuns.create({ id: 'restart-run', sessionId: 'restart-session', title: 'Restart task' });
  taskRuns.append('restart-run', { type: 'run.started' });
  const agent = fakeAgent(async function* () {});
  const web = await startMossWebServer(agent, {
    port: 0,
    taskRunLedger: taskRuns,
    eventJournalFile: journalFile,
  });
  try {
    assert.equal(taskRuns.get('restart-run').status, 'interrupted');
    const replay = await fetch(`${web.url}/api/runs/restart-run/events`);
    const body = await replay.text();
    assert.match(body, /event: interrupted/);
    assert.match(body, /"reason":"host restarted"/);
    assert.doesNotMatch(body, /"type":"done"/);
  } finally {
    await web.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
