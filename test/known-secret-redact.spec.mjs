#!/usr/bin/env node
/**
 * A key dumped with `od -c` and typed back in the answer must not land in the
 * TUI transcript or in .moss session files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyAgentEvent,
  beginRun,
  createTuiStore,
  endRun,
} from '../dist/cli/tui/render-bridge.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { SessionEventLog } from '../dist/core/session/session-event.js';
import { appendSessionEvent } from '../dist/core/session/session-event-store.js';

const SECRET = 'sk-od-bypass-abcdefghijklmnopqrstuvwxyz123456';
const STORED = 'enc:' + 'C'.repeat(24);
const savedHome = process.env.HOME;
const savedKey = process.env.BOARD_API_KEY;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-known-secret-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.moss'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.moss', 'config.json'),
  JSON.stringify({ apiKey: STORED, provider: 'openai-compatible' })
);
process.env.HOME = home;
process.env.BOARD_API_KEY = SECRET;

const od = ['0000000', ...SECRET.split('').map((ch) => `  ${ch}`)].join('');
assert.equal(od.includes(SECRET), false, 'od -c does not contain the contiguous key');

try {
  const store = createTuiStore();
  beginRun(store);
  applyAgentEvent(store, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'od1',
    result: od,
    isError: false,
  });
  applyAgentEvent(store, {
    type: 'text_delta',
    delta: `The key from od is ${SECRET}. Stored blob ${STORED}.`,
  });
  endRun(store, false);

  const transcript = store.rows.map((row) => row.text).join('\n');
  assert.match(transcript, /0000000/, 'the od dump itself stays in the transcript');
  assert.doesNotMatch(transcript, new RegExp(SECRET), 'reassembled key is absent from the TUI');
  assert.doesNotMatch(transcript, new RegExp(STORED), 'stored credential is absent from the TUI');
  assert.match(transcript, /\[REDACTED\]/);

  const sessionsDir = path.join(root, '.moss', 'sessions');
  const sessions = new JsonlSessionStore({ dir: sessionsDir });
  await sessions.appendMessage('od-bypass', {
    role: 'assistant',
    content: `echoed ${SECRET} and ${STORED}`,
  });
  const sessionFile = fs.readdirSync(sessionsDir).find((name) => name.endsWith('.jsonl'));
  assert.ok(sessionFile, 'session jsonl was written under .moss');
  const sessionBody = fs.readFileSync(path.join(sessionsDir, sessionFile), 'utf8');
  assert.doesNotMatch(sessionBody, new RegExp(SECRET));
  assert.doesNotMatch(sessionBody, new RegExp(STORED));
  assert.match(sessionBody, /\[REDACTED\]/);

  const eventsDir = path.join(root, '.moss', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const eventFile = path.join(eventsDir, 'od-bypass.jsonl');
  const log = new SessionEventLog('od-bypass');
  const event = log.append({
    type: 'text.delta',
    data: { text: `prose ${SECRET}` },
  });
  appendSessionEvent(eventFile, event);
  const eventBody = fs.readFileSync(eventFile, 'utf8');
  assert.doesNotMatch(eventBody, new RegExp(SECRET));
  assert.match(eventBody, /\[REDACTED\]/);

  console.log('[PASS] known secret redaction in transcript and session files');
} finally {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedKey === undefined) delete process.env.BOARD_API_KEY;
  else process.env.BOARD_API_KEY = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
}
