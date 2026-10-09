#!/usr/bin/env node
/**
 * The live TUI tail redacts finished lines and holds a secret that is still
 * growing on the open line. Ordinary tokens stay visible. A secret split
 * across chunks must not flash.
 */
import assert from 'node:assert/strict';

import { liveAssistantText } from '../dist/cli/user-facing-text.js';
import {
  applyAgentEvent,
  beginRun,
  createTuiStore,
  endRun,
  reconcileFinalResponse,
} from '../dist/cli/tui/render-bridge.js';
import { renderLive, renderScrollableActivity } from '../dist/cli/tui/transcript.js';
import { createStreamingTextRedactor } from '../dist/safety/tool-output-redact.js';

const TOKEN = 'kube-token-value-1234567890';
const head = 'token: kube-token-val';
const tail = 'ue-1234567890';

function painted(text) {
  const live = renderLive(
    { running: true, streaming: text, thinking: '', tokensOut: 0, queued: 0 },
    80
  );
  const scroll = renderScrollableActivity('', text, 80);
  return [...live, ...scroll].map((entry) => entry.text).join('\n');
}

function screen(store) {
  return painted(liveAssistantText(store.run.streamingText));
}

assert.match(liveAssistantText('echo chunk 0 echo chunk 1 '), /echo chunk 0/);
assert.match(liveAssistantText('Hello token: kube-to'), /Hello/);
assert.doesNotMatch(liveAssistantText('Hello token: kube-to'), /kube/);

const store = createTuiStore();
beginRun(store);
applyAgentEvent(store, { type: 'text_delta', delta: 'Status is fine.\n' });
assert.match(store.rows.map((row) => row.text).join('\n'), /Status is fine/);

applyAgentEvent(store, { type: 'text_delta', delta: head });
assert.equal(store.run.streamingText, head);
assert.doesNotMatch(screen(store), /kube-token/);
assert.doesNotMatch(screen(store), new RegExp(TOKEN));

applyAgentEvent(store, { type: 'text_delta', delta: tail });
assert.equal(store.run.streamingText, head + tail);
assert.doesNotMatch(screen(store), /ue-1234567890/);
assert.doesNotMatch(screen(store), /kube-token/);
assert.doesNotMatch(screen(store), new RegExp(TOKEN));
assert.match(screen(store), /\[REDACTED\]/);

applyAgentEvent(store, { type: 'text_delta', delta: '\n' });
const rows = store.rows.map((row) => row.text).join('\n');
assert.match(rows, /\[REDACTED\]/);
assert.match(rows, /Status is fine/);
assert.doesNotMatch(rows, /kube-token/);
assert.doesNotMatch(rows, /ue-1234567890/);
assert.doesNotMatch(rows, new RegExp(TOKEN));
assert.doesNotMatch(screen(store), new RegExp(TOKEN));

const pemBody = 'b3BlbnNzaC1rZXktdmFsdWUtZmFrZS0xMjM0NTY3ODkw';
const openPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${pemBody}`;
assert.doesNotMatch(liveAssistantText(`before\n${openPem}`), new RegExp(pemBody));
assert.match(liveAssistantText(`before\n${openPem}`), /before/);

const mention = 'The header is -----BEGIN OPENSSH PRIVATE KEY----- and then more prose.';
assert.match(liveAssistantText(mention), /and then more prose/);
assert.match(liveAssistantText(mention), /The header is/);

const closedPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${pemBody}\n-----END OPENSSH PRIVATE KEY-----\nAfter the key.\n`;
assert.doesNotMatch(liveAssistantText(closedPem), new RegExp(pemBody));
assert.match(liveAssistantText(closedPem), /\[REDACTED\]/);
assert.match(liveAssistantText(closedPem), /After the key/);

function flushed(chunks) {
  const redactor = createStreamingTextRedactor();
  let out = '';
  for (const chunk of chunks) out += redactor.push(chunk);
  out += redactor.flush();
  return out;
}

const mentionOut = flushed([mention + '\n']);
assert.match(mentionOut, /and then more prose/, 'mid-sentence header is not a PEM hold');

const unclosed = flushed([
  'Before.\n-----BEGIN OPENSSH PRIVATE KEY-----\n',
  `${pemBody}\nThe explanation continues after the header.\n`,
]);
assert.match(unclosed, /Before/);
assert.doesNotMatch(unclosed, new RegExp(pemBody), 'flush redacts an unclosed private key');
assert.doesNotMatch(
  unclosed,
  /explanation continues/,
  'an unclosed line-start header redacts through the end of the text'
);
assert.match(unclosed, /\[REDACTED\]/);
assert.doesNotMatch(
  createStreamingTextRedactor().push(
    `Before.\n-----BEGIN OPENSSH PRIVATE KEY-----\n${pemBody}\nThe explanation continues after the header.\n`
  ),
  new RegExp(pemBody),
  'an open line-start header is still held until flush'
);

const pemOut = flushed([closedPem]);
assert.doesNotMatch(pemOut, new RegExp(pemBody), 'a real PEM block is redacted');
assert.match(pemOut, /\[REDACTED\]/);
assert.match(pemOut, /After the key/);

{
  const pemStore = createTuiStore();
  beginRun(pemStore);
  applyAgentEvent(pemStore, { type: 'text_delta', delta: 'See the header.' });
  applyAgentEvent(pemStore, { type: 'turn_end', turn: 1, stopReason: 'stop' });
  reconcileFinalResponse(
    pemStore,
    'See the header. -----BEGIN OPENSSH PRIVATE KEY----- and the rest of the answer.'
  );
  const answers = pemStore.rows.filter((row) => row.kind === 'assistant').map((row) => row.text);
  assert.equal(answers.length, 1, 'a mismatched prefix replaces the row instead of appending');
  assert.match(answers[0], /rest of the answer/);
  assert.match(answers[0], /See the header/);
}

endRun(store, false);
const committed = store.rows.map((row) => row.text).join('\n');
assert.doesNotMatch(committed, new RegExp(TOKEN));
assert.match(committed, /\[REDACTED\]/);

console.log('[PASS] TUI live stream holds an open secret and redacts finished lines');
