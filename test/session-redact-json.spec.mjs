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

const log = new SessionEventLog('cat-env');
appendSessionEvent(eventFile, log.append({ type: 'text.delta', data: { text: TOOL_TEXT } }));
const eventLine = fs.readFileSync(eventFile, 'utf8').trim();
const event = JSON.parse(eventLine);
assert.equal(eventLine.includes(SECRET), false, 'event line leaks');
assert.match(event.data.text, /DB_HOST=db\.internal/);
assert.match(event.data.text, /\[REDACTED\]/);

fs.rmSync(root, { recursive: true, force: true });
console.log('[PASS] session JSONL redaction stays parseable');
