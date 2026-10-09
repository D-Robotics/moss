#!/usr/bin/env node
/**
 * Egress redaction: sensitive file content, assignment rules, known values,
 * every user-facing path, exec write-back of [REDACTED], and source identifiers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execBackgroundTool } from '../dist/tools/background-exec.js';
import { execTool, readFileTool, writeFileTool } from '../dist/tools/builtin.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { clearBackgroundRegistryForTests } from '../dist/core/tools/background-process-registry.js';
import {
  buildBackgroundCompletionSystemText,
  clearBackgroundCompletionReminderForTests,
  ensureBackgroundCompletionTracker,
} from '../dist/core/loop/background-completion.js';
import { createMossAgentLoopEventAdapter } from '../dist/core/agent/moss-agent-loop-adapter.js';
import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { appendSessionEvent } from '../dist/core/session/session-event-store.js';
import { SessionEventLog } from '../dist/core/session/session-event.js';
import { createCliRunRenderer } from '../dist/cli/output.js';
import { createHeadlessPrintState, formatHeadlessStreamEvent } from '../dist/cli/print.js';
import { userFacingAssistantText } from '../dist/cli/user-facing-text.js';
import { presentToolOutput, redactEgress } from '../dist/safety/tool-output-redact.js';

const SERVICE = 'Abcd1234efgh5678';
const AWS = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KNOWN = 'egress-spec-value-12345678';
const PEM_BODY = 'b3BlbnNzaC1rZXktdmFsdWUtZmFrZS0xMjM0NTY3ODkw';
const NETRC = 'netrc-secret-value1';
const DOCKER = 'ZG9ja2VyLXNlY3JldC12YWx1ZTE=';
const KUBE_TOKEN = 'kube-token-value-1234567890';
const KUBE_KEY = 'a3ViZS1jbGllbnQta2V5LWRhdGEtdmFsdWUxMjM0NTY=';
const SECRETS = [SERVICE, AWS, KNOWN, PEM_BODY, NETRC, DOCKER, KUBE_TOKEN, KUBE_KEY];

const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----\n`;
const PARAGRAPH = [
  `SERVICE_TOKEN=${SERVICE}`,
  `aws_secret_access_key = ${AWS}`,
  `loose ${KNOWN}`,
  PEM.trimEnd(),
  `password ${NETRC}`,
  `"auth": "${DOCKER}"`,
  `token: ${KUBE_TOKEN}`,
  `client-key-data: ${KUBE_KEY}`,
].join('\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-egress-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
fs.mkdirSync(path.join(home, '.docker'), { recursive: true });
fs.mkdirSync(path.join(home, '.kube'), { recursive: true });
fs.mkdirSync(project, { recursive: true });
process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});

const savedKey = process.env.EGRESS_SPEC_API_KEY;
process.env.EGRESS_SPEC_API_KEY = KNOWN;

function assertAbsent(text, label) {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `${label} still contains a secret value`);
  }
}

function modelView(toolName, input, raw) {
  return presentToolOutput({
    toolName,
    input,
    text: String(raw),
    workspaceDir: project,
    env: process.env,
  });
}

const ctx = () => ({
  workspaceDir: project,
  sessionKey: 'egress-redact',
  abortSignal: new AbortController().signal,
});

try {
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), PEM);
  fs.writeFileSync(
    path.join(home, '.aws', 'credentials'),
    `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${AWS}\n`
  );
  fs.writeFileSync(
    path.join(home, '.netrc'),
    `machine example.com\nlogin builder\npassword ${NETRC}\n`
  );
  fs.writeFileSync(
    path.join(home, '.docker', 'config.json'),
    JSON.stringify({ auths: { 'https://index.docker.io/v1/': { auth: DOCKER } } })
  );
  fs.writeFileSync(
    path.join(home, '.kube', 'config'),
    `apiVersion: v1\nkind: Config\nusers:\n- name: fake\n  user:\n    token: ${KUBE_TOKEN}\n    client-key-data: ${KUBE_KEY}\n`
  );
  fs.writeFileSync(path.join(project, '.env'), PARAGRAPH + '\n');

  const sensitive = [
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.netrc'),
    path.join(home, '.docker', 'config.json'),
    path.join(home, '.kube', 'config'),
    path.join(project, '.env'),
  ];
  for (const file of sensitive) {
    const raw = await readFileTool.execute({ path: file }, ctx());
    assert.doesNotMatch(String(raw), /denied|Command blocked/i, `read stays allowed: ${file}`);
    const viewed = modelView('read_file', { path: file }, raw);
    assertAbsent(viewed, `read_file ${path.basename(file)}`);
    assert.match(viewed, /\[REDACTED\]/, `read_file ${path.basename(file)} redacts`);
  }

  const numberedPem = [
    'alpha',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    PEM_BODY,
    '-----END OPENSSH PRIVATE KEY-----',
    `token: ${KUBE_TOKEN}`,
    'omega',
  ].join('\n');
  fs.writeFileSync(path.join(project, 'numbered.pem'), numberedPem);
  const numberedRaw = String(
    await readFileTool.execute({ path: path.join(project, 'numbered.pem') }, ctx())
  );
  const numberedView = modelView('read_file', { path: 'numbered.pem' }, numberedRaw);
  const numberedLines = numberedView.split('\n');
  assert.equal(
    numberedLines.length,
    numberedRaw.split('\n').length,
    'redaction keeps the read_file line count'
  );
  assert.match(numberedLines[0], /1\talpha/);
  assert.match(numberedLines[1], /2\t\[REDACTED\]/);
  assert.match(numberedLines[2], /3\t\[REDACTED\]/);
  assert.match(numberedLines[3], /4\t\[REDACTED\]/);
  assert.match(numberedLines[4], /5\ttoken: \[REDACTED\]/);
  assert.match(numberedLines[5], /6\tomega/);
  assert.doesNotMatch(numberedView, new RegExp(PEM_BODY));
  assert.doesNotMatch(numberedView, new RegExp(KUBE_TOKEN));

  const assigned = redactEgress(`SERVICE_TOKEN=${SERVICE}\naws_secret_access_key = ${AWS}\n`);
  assertAbsent(assigned, 'assignment rules');
  assert.match(assigned, /SERVICE_TOKEN=\[REDACTED\]/);
  assert.match(assigned, /aws_secret_access_key = \[REDACTED\]/);

  const loose = modelView('read_file', { path: 'loose.txt' }, `remember ${KNOWN} please`);
  assert.doesNotMatch(loose, new RegExp(KNOWN), 'known env value is removed from tool output');

  const live = [];
  const execRaw = await execTool.execute(
    { command: 'cat .env' },
    { ...ctx(), onToolOutput: (text) => live.push(text) }
  );
  assertAbsent(live.join(''), 'exec live stream');
  assertAbsent(modelView('exec', { command: 'cat .env' }, execRaw), 'exec tool result');

  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();
  ensureBackgroundCompletionTracker();
  const leakCommand =
    process.platform === 'win32'
      ? `node -e "setTimeout(() => { process.stdout.write(require('fs').readFileSync('.env','utf8')); }, 300)"`
      : 'sleep 0.3; cat .env';
  const started = await execBackgroundTool.execute({ command: leakCommand, settle_ms: 40 }, ctx());
  assert.match(String(started), /Started|Still running|exited immediately/);
  let reminder = null;
  for (let i = 0; i < 20 && !reminder; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reminder = buildBackgroundCompletionSystemText();
  }
  assert.ok(reminder, 'background completion notice was produced');
  assertAbsent(reminder, 'background completion notice');
  const sessionsDir = path.join(project, '.moss', 'sessions');
  const sessions = new JsonlSessionStore({ dir: sessionsDir });
  await sessions.appendMessage('egress', {
    role: 'assistant',
    content: `${reminder}\n${PARAGRAPH}`,
  });
  const sessionFile = fs.readdirSync(sessionsDir).find((name) => name.endsWith('.jsonl'));
  assert.ok(sessionFile, 'session jsonl written');
  assertAbsent(fs.readFileSync(path.join(sessionsDir, sessionFile), 'utf8'), 'session log');

  const eventsDir = path.join(project, '.moss', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const eventFile = path.join(eventsDir, 'egress.jsonl');
  const log = new SessionEventLog('egress');
  appendSessionEvent(eventFile, log.append({ type: 'text.delta', data: { text: PARAGRAPH } }));
  assertAbsent(fs.readFileSync(eventFile, 'utf8'), 'session event log');

  assertAbsent(userFacingAssistantText(PARAGRAPH), 'assistant text');

  const headless = createHeadlessPrintState({ sessionId: 'egress' });
  formatHeadlessStreamEvent(headless, { type: 'text_delta', delta: PARAGRAPH });
  const flushed = formatHeadlessStreamEvent(headless, {
    type: 'turn_end',
    turn: 1,
    stopReason: 'end_turn',
  });
  assertAbsent(JSON.stringify(flushed), 'headless stream');

  const unclosedHeader = `Before.\n-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\nThe explanation continues after the header.\n`;
  const headlessPem = createHeadlessPrintState({ sessionId: 'egress-pem' });
  formatHeadlessStreamEvent(headlessPem, { type: 'text_delta', delta: unclosedHeader });
  const pemFlushed = formatHeadlessStreamEvent(headlessPem, {
    type: 'turn_end',
    turn: 1,
    stopReason: 'end_turn',
  });
  const headlessText = JSON.stringify(pemFlushed);
  assert.match(headlessText, /Before/, 'headless flush keeps the prose before an unclosed header');
  assert.doesNotMatch(headlessText, new RegExp(PEM_BODY), 'headless flush redacts an unclosed key');
  assert.doesNotMatch(
    headlessText,
    /explanation continues/,
    'headless flush redacts through the end of an unclosed private key'
  );
  assert.match(headlessText, /\[REDACTED\]/, 'headless flush emits the redacted tail');
  assert.doesNotMatch(
    userFacingAssistantText(unclosedHeader),
    new RegExp(PEM_BODY),
    'assistant text redacts an unclosed private key'
  );

  const pemChunks = [];
  const pemRenderer = createCliRunRenderer({
    detailMode: 'quiet',
    interactive: false,
    workspaceDir: project,
    stdout: {
      write: (value) => {
        pemChunks.push(String(value));
        return true;
      },
    },
    stderr: { write: () => true, isTTY: false },
  });
  pemRenderer.handle({ type: 'text_delta', delta: unclosedHeader });
  pemRenderer.dispose();
  const replText = pemChunks.join('');
  assert.match(replText, /Before/, 'REPL flush keeps the prose before an unclosed header');
  assert.doesNotMatch(replText, new RegExp(PEM_BODY), 'REPL flush redacts an unclosed key');
  assert.doesNotMatch(
    replText,
    /explanation continues/,
    'REPL flush redacts through the end of an unclosed private key'
  );
  assert.match(replText, /\[REDACTED\]/, 'REPL flush emits the redacted tail');

  const headCut = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n`;
  const modelHead = modelView('exec', { command: 'head -n 2 ~/.ssh/id_ed25519' }, headCut);
  assert.doesNotMatch(modelHead, new RegExp(PEM_BODY), 'unclosed key is not sent to the model');
  assert.match(modelHead, /\[REDACTED\]/);

  const openNumbered = ['alpha', '-----BEGIN OPENSSH PRIVATE KEY-----', PEM_BODY, 'omega'].join(
    '\n'
  );
  fs.writeFileSync(path.join(project, 'open-key.pem'), openNumbered);
  const openRaw = String(
    await readFileTool.execute({ path: path.join(project, 'open-key.pem') }, ctx())
  );
  const openView = modelView('read_file', { path: 'open-key.pem' }, openRaw);
  const openLines = openView.split('\n');
  assert.equal(openLines.length, openRaw.split('\n').length, 'unclosed PEM keeps read_file lines');
  assert.match(openLines[0], /1\talpha/);
  assert.match(openLines[1], /2\t\[REDACTED\]/);
  assert.match(openLines[3], /4\t\[REDACTED\]/);
  assert.doesNotMatch(openView, new RegExp(PEM_BODY));
  assert.doesNotMatch(openView, /\bomega\b/);

  const chunks = [];
  const renderer = createCliRunRenderer({
    detailMode: 'quiet',
    interactive: false,
    workspaceDir: project,
    stdout: {
      write: (value) => {
        chunks.push(String(value));
        return true;
      },
    },
    stderr: { write: () => true, isTTY: false },
  });
  renderer.handle({ type: 'text_delta', delta: PARAGRAPH });
  renderer.dispose();
  assertAbsent(chunks.join(''), 'REPL stdout');

  const adapter = createMossAgentLoopEventAdapter();
  const sdkEvents = [
    ...adapter.onMiniEvent({ type: 'message_delta', delta: PARAGRAPH }),
    ...adapter.onMiniEvent({
      type: 'message_end',
      text: PARAGRAPH,
      message: { role: 'assistant', content: PARAGRAPH },
    }),
  ];
  assertAbsent(JSON.stringify(sdkEvents), 'SDK text_delta');
  const sdkResult = adapter.getResult({
    finalText: PARAGRAPH,
    turns: 1,
    totalToolCalls: 0,
    messages: [],
  });
  assertAbsent(sdkResult.response, 'SDK result');

  await recordEvidenceTool.execute(
    {
      metric: 'leak-check',
      source: 'exec',
      expected: 'contains ok',
      observed: PARAGRAPH,
      details: PARAGRAPH,
    },
    ctx()
  );
  assertAbsent(
    fs.readFileSync(path.join(project, '.moss', 'evidence.jsonl'), 'utf8'),
    'evidence record'
  );

  const original = 'DB_PASSWORD=original-value-1234\n';
  fs.writeFileSync(path.join(project, '.env'), original);
  const printfRefused = await execTool.execute(
    { command: `printf 'DB_PASSWORD=[REDACTED]\\n' > .env` },
    ctx()
  );
  assert.match(String(printfRefused), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), original);

  const sedRefused = await execTool.execute(
    { command: `sed -i 's/DB_PASSWORD=.*/DB_PASSWORD=[REDACTED]/' .env` },
    ctx()
  );
  assert.match(String(sedRefused), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), original);

  const bgRefused = await execBackgroundTool.execute(
    { command: `printf 'X=[REDACTED]' > .env`, settle_ms: 40 },
    ctx()
  );
  assert.match(String(bgRefused), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), original);

  const assembled = await execTool.execute(
    { command: `node -e "process.stdout.write('DB_PASSWORD=[REDA'+'CTED]\\n')" > .env` },
    ctx()
  );
  assert.match(String(assembled), /must be restored from the original source/);
  assert.match(String(assembled), /\.env/);
  assert.doesNotMatch(String(assembled), /Restored:/);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'DB_PASSWORD=[REDACTED]\n');

  const placeholderBody = 'keep [REDACTED] please\n';
  fs.writeFileSync(path.join(project, 'already.txt'), placeholderBody);
  const copied = await execTool.execute({ command: 'cp already.txt copy.txt' }, ctx());
  assert.equal(fs.readFileSync(path.join(project, 'already.txt'), 'utf8'), placeholderBody);
  assert.equal(fs.readFileSync(path.join(project, 'copy.txt'), 'utf8'), placeholderBody);
  assert.doesNotMatch(String(copied), /must be restored from the original source/);

  fs.writeFileSync(path.join(project, 'move-src.txt'), placeholderBody);
  const moved = await execTool.execute({ command: 'mv move-src.txt move-dst.txt' }, ctx());
  assert.equal(fs.existsSync(path.join(project, 'move-src.txt')), false);
  assert.equal(fs.readFileSync(path.join(project, 'move-dst.txt'), 'utf8'), placeholderBody);
  assert.doesNotMatch(String(moved), /must be restored from the original source/);

  fs.writeFileSync(path.join(project, 'note.txt'), 'alpha [REDACTED] omega\n');
  const legit = await execTool.execute({ command: "sed -i 's/alpha/beta/' note.txt" }, ctx());
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'beta [REDACTED] omega\n');
  assert.doesNotMatch(String(legit), /must be restored from the original source/);

  fs.writeFileSync(path.join(project, 'both.txt'), 'alpha SECRET-value-1234\n');
  const both = await execTool.execute(
    {
      command: `sed -i "s/alpha/beta/; s/SECRET-value-1234/$(printf '%s%s' '[REDA' 'CTED]')/" both.txt`,
    },
    ctx()
  );
  assert.equal(fs.readFileSync(path.join(project, 'both.txt'), 'utf8'), 'beta [REDACTED]\n');
  assert.match(String(both), /must be restored from the original source/);
  assert.match(String(both), /both\.txt/);
  assert.doesNotMatch(String(both), /Restored:/);

  const bgWritten = await execBackgroundTool.execute(
    {
      command: `node -e "process.stdout.write('K=[REDA'+'CTED]\\n')" > bg-out.txt`,
      settle_ms: 2000,
    },
    ctx()
  );
  assert.equal(fs.readFileSync(path.join(project, 'bg-out.txt'), 'utf8'), 'K=[REDACTED]\n');
  assert.match(String(bgWritten), /must be restored from the original source/);
  assert.doesNotMatch(String(bgWritten), /Restored:/);

  const splitHead = 'token: kube-token-val';
  const splitTail = 'ue-1234567890\n';
  assert.equal(splitHead + splitTail, `token: ${KUBE_TOKEN}\n`);
  const splitAdapter = createMossAgentLoopEventAdapter();
  const splitEvents = [
    ...splitAdapter.onMiniEvent({ type: 'message_delta', delta: splitHead }),
    ...splitAdapter.onMiniEvent({ type: 'message_delta', delta: splitTail }),
  ];
  const splitStream = JSON.stringify(splitEvents);
  assert.doesNotMatch(splitStream, /ue-1234567890/);
  assert.doesNotMatch(splitStream, new RegExp(KUBE_TOKEN));
  assert.match(splitStream, /\[REDACTED\]/);

  const splitHeadless = createHeadlessPrintState({ sessionId: 'split' });
  for (const ev of splitEvents) formatHeadlessStreamEvent(splitHeadless, ev);
  const splitFlushed = formatHeadlessStreamEvent(splitHeadless, {
    type: 'turn_end',
    turn: 1,
    stopReason: 'end_turn',
  });
  const splitHeadlessJson = JSON.stringify(splitFlushed);
  assert.doesNotMatch(splitHeadlessJson, /ue-1234567890/);
  assert.doesNotMatch(splitHeadlessJson, new RegExp(KUBE_TOKEN));

  const rawHeadless = createHeadlessPrintState({ sessionId: 'split-raw' });
  formatHeadlessStreamEvent(rawHeadless, { type: 'text_delta', delta: splitHead });
  formatHeadlessStreamEvent(rawHeadless, { type: 'text_delta', delta: splitTail });
  const rawFlushed = formatHeadlessStreamEvent(rawHeadless, {
    type: 'turn_end',
    turn: 1,
    stopReason: 'end_turn',
  });
  assert.doesNotMatch(JSON.stringify(rawFlushed), /ue-1234567890/);

  const splitChunks = [];
  const splitRenderer = createCliRunRenderer({
    detailMode: 'quiet',
    interactive: false,
    workspaceDir: project,
    stdout: {
      write: (value) => {
        splitChunks.push(String(value));
        return true;
      },
    },
    stderr: { write: () => true, isTTY: false },
  });
  splitRenderer.handle({ type: 'text_delta', delta: splitHead });
  splitRenderer.handle({ type: 'text_delta', delta: splitTail });
  splitRenderer.dispose();
  const splitOut = splitChunks.join('');
  assert.doesNotMatch(splitOut, /ue-1234567890/);
  assert.doesNotMatch(splitOut, new RegExp(KUBE_TOKEN));
  assert.match(splitOut, /\[REDACTED\]/);

  const source = 'password: hashedPasswordValue,\ntoken = someLongIdentifierName\n';
  assert.equal(redactEgress(source), source, 'bare identifiers stay in source');
  fs.writeFileSync(path.join(project, 'idents.ts'), source);
  const sourceRead = await readFileTool.execute({ path: 'idents.ts' }, ctx());
  const sourceView = modelView('read_file', { path: 'idents.ts' }, sourceRead);
  assert.match(sourceView, /hashedPasswordValue/);
  assert.match(sourceView, /someLongIdentifierName/);
  assert.doesNotMatch(sourceView, /\[REDACTED\]/);
  const roundTrip = await writeFileTool.execute({ path: 'idents.ts', content: source }, ctx());
  assert.match(String(roundTrip), /Successfully wrote/);
  assert.equal(fs.readFileSync(path.join(project, 'idents.ts'), 'utf8'), source);
  const poisoned = await writeFileTool.execute(
    {
      path: 'idents.ts',
      content: 'password: [REDACTED],\ntoken = [REDACTED]\n',
    },
    ctx()
  );
  assert.match(String(poisoned), /refusing to write \[REDACTED\]/);
  assert.equal(fs.readFileSync(path.join(project, 'idents.ts'), 'utf8'), source);

  console.log('[PASS] egress redaction');
} finally {
  if (savedKey === undefined) delete process.env.EGRESS_SPEC_API_KEY;
  else process.env.EGRESS_SPEC_API_KEY = savedKey;
  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();
}
