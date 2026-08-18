#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InMemorySessionStore } from '../dist/core/session/session.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

function fakeAgent(workspaceDir, capture) {
  return {
    config: {
      sessionStore: new InMemorySessionStore(),
      model: 'attachment-model',
      workspaceDir,
    },
    tools: { getNames: () => [] },
    plugins: {
      inspect: () => ({ generation: 0, plugins: [] }),
      listCommands: () => [],
      subscribe: () => () => {},
    },
    setUserQuestionAsker() {
      return () => {};
    },
    async *streamChat(_sessionId, _prompt, options) {
      capture.attachments = options.attachments;
      yield {
        type: 'done',
        result: { response: '', toolCalls: [], toolResults: [], stopReason: 'end_turn' },
      };
    },
  };
}

test('Web mutations require strict Origin and per-server CSRF while attachment GET stays readable', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-attachment-http-'));
  const capture = {};
  const web = await startMossWebServer(fakeAgent(tempDir, capture), { port: 0 });
  try {
    const bootstrap = await fetch(`${web.url}/api/bootstrap`).then((response) => response.json());
    assert.equal(typeof bootstrap.csrfToken, 'string');
    const authorizedHeaders = {
      origin: web.url,
      'x-moss-csrf': bootstrap.csrfToken,
      'content-type': 'application/json',
    };

    assert.equal((await fetch(`${web.url}/api/sessions`, { method: 'POST' })).status, 403);
    assert.equal(
      (
        await fetch(`${web.url}/api/sessions`, {
          method: 'POST',
          headers: { ...authorizedHeaders, 'x-moss-csrf': 'wrong' },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${web.url}/api/sessions`, {
          method: 'POST',
          headers: { ...authorizedHeaders, origin: 'http://attacker.invalid' },
        })
      ).status,
      403
    );

    const sessionResponse = await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: authorizedHeaders,
    });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();

    const uploaded = await fetch(`${web.url}/api/attachments`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({
        filename: 'note.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('real attachment body').toString('base64'),
      }),
    }).then((response) => response.json());
    const download = await fetch(`${web.url}${uploaded.attachment.downloadUrl}`);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(await download.text(), 'real attachment body');

    const turn = await fetch(`${web.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: authorizedHeaders,
      body: JSON.stringify({
        prompt: 'Read the attachment',
        attachmentIds: [uploaded.attachment.id],
      }),
    });
    assert.equal(turn.status, 200);
    await turn.text();
    assert.deepEqual(capture.attachments, [
      { type: 'text', text: '[Attachment: note.txt]\nreal attachment body' },
    ]);
  } finally {
    await web.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
