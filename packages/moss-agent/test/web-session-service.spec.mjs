#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizedWebFetch as fetch } from './web-authorized-fetch.mjs';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { TaskRunLedger } from '../dist/core/task-run/task-run-ledger.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { MossWebSessionService } from '../dist/web-ui/web-session-service.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

function makeAgent(store, workspaceDir) {
  return new MossAgent({
    llmProvider: {
      id: 'web-session-service-test',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [] };
      },
    },
    sessionStore: store,
    workspaceDir,
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
}

test('Web session service preserves source history across fork and rewind', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss web sessions 空格 '));
  const metadataFile = path.join(tempDir, '.moss', 'web session metadata.json');
  const store = new JsonlSessionStore({ dir: path.join(tempDir, '会话 files') });
  const agent = makeAgent(store, tempDir);
  const taskRuns = new TaskRunLedger();
  await store.replaceMessages('source/session', [
    { role: 'user', content: 'Find the alpha regression' },
    { role: 'assistant', content: [{ type: 'text', text: 'Alpha evidence' }] },
    { role: 'user', content: 'Continue with beta' },
  ]);
  const service = new MossWebSessionService(agent, taskRuns, { metadataFile });
  try {
    assert.deepEqual(await service.listWorkspaces(), [
      { id: 'current', name: path.basename(tempDir), current: true },
    ]);
    assert.equal((await service.search('alpha'))[0].sessionId, 'source/session');

    const renamed = await service.rename('source/session', 'Renamed investigation');
    assert.equal(renamed.title, 'Renamed investigation');
    const reloaded = new MossWebSessionService(agent, taskRuns, { metadataFile });
    assert.equal((await reloaded.listSessions())[0].title, 'Renamed investigation');

    const markdown = await service.exportMarkdown('source/session');
    assert.match(markdown, /^# Session source\/session/m);
    assert.match(markdown, /Alpha evidence/);

    const fork = await service.fork('source/session');
    assert.equal(fork.messageCount, 3);
    assert.deepEqual(
      await store.loadMessages(fork.sessionId),
      await store.loadMessages('source/session')
    );

    const rewind = await service.rewind('source/session', 1);
    assert.equal(rewind.sourceSessionId, 'source/session');
    assert.equal(rewind.truncated, 2);
    assert.equal((await store.loadMessages(rewind.session.sessionId)).length, 1);
    assert.equal((await store.loadMessages('source/session')).length, 3, 'source remains intact');

    const created = await service.create();
    assert.equal(created.messageCount, 0);
    assert.ok(
      (await service.listSessions()).some(({ sessionId }) => sessionId === created.sessionId)
    );

    await assert.rejects(
      service.delete('source/session', 'wrong confirmation'),
      /delete confirmation must exactly match/
    );
    assert.equal(await store.exists('source/session'), true);
    await service.delete('source/session', 'source/session');
    assert.equal(await store.exists('source/session'), false);
  } finally {
    await agent.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Web session HTTP protocol exposes mutations with exact delete confirmation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-session-http-'));
  const store = new InMemorySessionStore();
  const agent = makeAgent(store, tempDir);
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    const workspaces = await fetch(`${web.url}/api/workspaces`).then((response) => response.json());
    assert.equal(workspaces.workspaces[0].id, 'current');

    const created = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'current' }),
    }).then((response) => response.json());
    await store.replaceMessages(created.sessionId, [
      { role: 'user', content: 'Protocol needle' },
      { role: 'assistant', content: 'Protocol result' },
    ]);

    const renamedResponse = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Protocol session' }),
      }
    );
    assert.equal(renamedResponse.status, 200);
    assert.equal((await renamedResponse.json()).session.title, 'Protocol session');

    const search = await fetch(`${web.url}/api/sessions/search?q=needle`).then((response) =>
      response.json()
    );
    assert.equal(search.hits[0].sessionId, created.sessionId);

    const exported = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/export`
    );
    assert.match(exported.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await exported.text(), /Protocol result/);

    const forked = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/fork`,
      { method: 'POST' }
    ).then((response) => response.json());
    assert.equal(forked.session.messageCount, 2);

    const rewound = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}/rewind`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageCount: 1 }),
      }
    ).then((response) => response.json());
    assert.equal(rewound.session.messageCount, 1);
    assert.equal((await store.loadMessages(created.sessionId)).length, 2);

    const deniedDelete = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'not-the-session' }),
      }
    );
    assert.equal(deniedDelete.status, 400);
    assert.equal(await store.exists(created.sessionId), true);

    const deleted = await fetch(
      `${web.url}/api/sessions/${encodeURIComponent(created.sessionId)}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: created.sessionId }),
      }
    );
    assert.equal(deleted.status, 200);
    assert.equal(await store.exists(created.sessionId), false);
  } finally {
    await web.close();
    await agent.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
