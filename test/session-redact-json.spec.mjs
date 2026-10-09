#!/usr/bin/env node
/**
 * Whole-line session redaction must not break JSON. `Password=\S{8,}` used to
 * swallow the closing `"}]}` after `DB_PASSWORD=[REDACTED]`, and reload dropped
 * the tool_result line.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { SessionEventLog } from '../dist/core/session/session-event.js';
import { appendSessionEvent } from '../dist/core/session/session-event-store.js';

const SECRET = 'Sup3rSecretValue99';
const TOOL_TEXT = `DB_HOST=db.internal\nDB_PASSWORD=${SECRET}\nAPP_PORT=8080\nPassword=${SECRET}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-session-redact-'));
const sessionsDir = path.join(root, 'sessions');
const eventFile = path.join(root, 'events', 'cat-env.jsonl');
fs.mkdirSync(sessionsDir, { recursive: true });

const user = { role: 'user', content: 'cat .env' };
const tool = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'call_1', content: TOOL_TEXT }],
};
const assistant = { role: 'assistant', content: 'done' };

const store = new JsonlSessionStore({ dir: sessionsDir });
await store.appendMessage('cat-env', user);
await store.appendMessage('cat-env', tool);
await store.appendMessage('cat-env', assistant);

const sessionFile = path.join(sessionsDir, 'cat-env.jsonl');
const sessionLines = fs
  .readFileSync(sessionFile, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0);
for (const line of sessionLines) {
  JSON.parse(line);
}
assert.equal(sessionLines.length, 3, 'each appended message is one JSON line');
assert.equal(fs.readFileSync(sessionFile, 'utf8').includes(SECRET), false, 'session file leaks');

const loaded = await store.loadMessages('cat-env');
assert.equal(loaded.length, 3, 'reload keeps the tool_result line');
const loadedText = JSON.stringify(loaded);
assert.equal(loadedText.includes(SECRET), false, 'reloaded messages leak');
assert.match(loadedText, /DB_HOST=db\.internal/);
assert.match(loadedText, /APP_PORT=8080/);
assert.match(loadedText, /\[REDACTED\]/);

await store.replaceMessages('cat-env', [user, tool, assistant]);
const replacedLines = fs
  .readFileSync(sessionFile, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0);
for (const line of replacedLines) JSON.parse(line);
const replaced = await store.loadMessages('cat-env');
assert.equal(replaced.length, 3, 'replaceMessages reload still has 3 messages');
assert.equal(JSON.stringify(replaced).includes(SECRET), false, 'replaced session leaks');
assert.match(JSON.stringify(replaced), /DB_HOST=db\.internal/);

const parallel = {
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'call_A', content: TOOL_TEXT },
    {
      type: 'tool_result',
      tool_use_id: 'call_B',
      content: 'Found 1 file(s) (newest first):\n.env',
    },
  ],
};
await store.appendMessage('cat-env-parallel', parallel);
const parallelFile = path.join(sessionsDir, 'cat-env-parallel.jsonl');
const parallelRaw = fs.readFileSync(parallelFile, 'utf8');
const parallelLine = JSON.parse(parallelRaw);
assert.equal(parallelRaw.includes(SECRET), false, 'parallel session file leaks');
assert.match(parallelRaw, /call_A/);
assert.match(parallelRaw, /call_B/);
assert.match(parallelRaw, /Found 1 file\(s\) \(newest first\)/);
assert.match(parallelRaw, /\.env/);
const parallelLoaded = await store.loadMessages('cat-env-parallel');
assert.equal(parallelLoaded.length, 1);
const parallelContent = parallelLoaded[0].content;
assert.equal(parallelContent.length, 2);
assert.equal(parallelContent[0].tool_use_id, 'call_A');
assert.equal(parallelContent[1].tool_use_id, 'call_B');
assert.equal(parallelContent[1].content, 'Found 1 file(s) (newest first):\n.env');
assert.equal(JSON.stringify(parallelLoaded).includes(SECRET), false, 'parallel reload leaks');
assert.equal(parallelLine.message.content.length, 2);
assert.match(parallelContent[0].content, /DB_HOST=db\.internal/);
assert.match(parallelContent[0].content, /\[REDACTED\]/);

const log = new SessionEventLog('cat-env');
appendSessionEvent(eventFile, log.append({ type: 'text.delta', data: { text: TOOL_TEXT } }));
const eventLine = fs.readFileSync(eventFile, 'utf8').trim();
const event = JSON.parse(eventLine);
assert.equal(eventLine.includes(SECRET), false, 'event line leaks');
assert.match(event.data.text, /DB_HOST=db\.internal/);
assert.match(event.data.text, /\[REDACTED\]/);

fs.rmSync(root, { recursive: true, force: true });
console.log('[PASS] session JSONL redaction stays parseable');
