#!/usr/bin/env node
/**
 * Conversation-rewind probe (offline, scripted provider).
 *
 * Claude's `/rewind` restores code AND conversation. This checks the two
 * halves of Moss's plan: `countSessionMessages` is the rollback point a
 * checkpoint records, and `rewindConversation` truncates the persisted LLM
 * history (so the next prompt never sees the undone turn).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { MossAgent } = await import(dist('core/agent/moss-agent.js'));
const { InMemorySessionStore } = await import(dist('core/session/session.js'));

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  async complete() {
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ack' }] };
  },
  async stream(_options, onEvent) {
    const response = await this.complete();
    onEvent({ type: 'message_start' });
    onEvent({ type: 'content_block_start' });
    onEvent({ type: 'content_block_delta', text: 'ack' });
    onEvent({ type: 'content_block_stop' });
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  },
};

const store = new InMemorySessionStore();
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: store,
  baseSystemPrompt: 'You are a test agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});
const sessionKey = 'rewind-probe';
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[rewind-conversation] ok ${name}`);
};

try {
  assert.equal(await agent.countSessionMessages(sessionKey), 0);
  await agent.chat(sessionKey, 'first message');
  const afterFirst = await agent.countSessionMessages(sessionKey);
  assert.ok(afterFirst >= 2, `first turn stored ${afterFirst} messages`);

  await agent.chat(sessionKey, 'second message');
  const afterSecond = await agent.countSessionMessages(sessionKey);
  assert.ok(afterSecond > afterFirst, 'second turn grew the history');
  ok('countSessionMessages tracks the stored history');

  const { truncated } = await agent.rewindConversation(sessionKey, afterFirst);
  assert.equal(truncated, afterSecond - afterFirst);
  assert.equal(await agent.countSessionMessages(sessionKey), afterFirst);
  const kept = await store.loadMessages(sessionKey);
  const texts = JSON.stringify(kept);
  assert.ok(texts.includes('first message'));
  assert.ok(!texts.includes('second message'), 'the undone turn is gone from LLM history');
  ok('rewindConversation drops exactly the undone turn');

  const noop = await agent.rewindConversation(sessionKey, afterFirst + 50);
  assert.equal(noop.truncated, 0, 'a target beyond the history is a no-op');
  ok('a forward target truncates nothing');

  // The checkpoint records the rollback point and hands it back on rewind.
  const runtimeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rewind-cp-')));
  const { FileCheckpointStore } = await import(dist('cli/file-checkpoint.js'));
  const ws = path.join(runtimeDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const target = path.join(ws, 'x.txt');
  fs.writeFileSync(target, 'orig');
  const cp = new FileCheckpointStore({ runtimeDir, sessionKey: 'cp' });
  cp.open('turn two', afterFirst);
  cp.trackBeforeWrite(target);
  fs.writeFileSync(target, 'changed');
  cp.noteAfterWrite(target);
  const restarted = new FileCheckpointStore({ runtimeDir, sessionKey: 'cp' });
  const result = restarted.rewindTo(1);
  assert.equal(result.messageCount, afterFirst);
  assert.equal(fs.readFileSync(target, 'utf8'), 'orig');
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  ok('a checkpoint carries the rollback point across a restart');
} finally {
  await agent.close();
}

// 5. B203: a stored harness correction never replays as a user turn.
{
  const { buildResumeReplay } = await import(dist('cli/resume-replay.js'));
  const replay = buildResumeReplay([
    { role: 'user', content: [{ type: 'text', text: 'add subtract() to sum.js' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Added subtract().' }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[System] You changed files but the last thing you did was answer your own claim.',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Verified with node --test.' }] },
  ]);
  assert.deepEqual(
    replay.items.map((item) => `${item.kind}:${item.text}`),
    [
      'user:add subtract() to sum.js',
      'assistant:Added subtract().',
      'assistant:Verified with node --test.',
    ],
    'the correction is dropped; real user/assistant turns remain'
  );
  ok('a stored [System] correction is not replayed as a user turn');

  // 6. B204: the injected <turn-context> preamble never replays as user text.
  const withContext = buildResumeReplay([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Add subtract() to sum.js\n\n<turn-context>\n## Environment\n- Working directory: /tmp/x\n</turn-context>',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Added.' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi\n\n<turn-context>\n## Available skills\n- a: b' }],
    },
  ]);
  assert.deepEqual(
    withContext.items.map((item) => `${item.kind}:${item.text}`),
    ['user:Add subtract() to sum.js', 'assistant:Added.', 'user:hi'],
    'the preamble is stripped, including an unclosed block'
  );
  // B230: loop guidance is model-facing; the resumed user never said it.
  const withSteering = buildResumeReplay([
    { role: 'user', content: [{ type: 'text', text: 'Fix the failing test.' }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[Steering] Extended tool loop detected — pause and summarize what is known.',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  assert.deepEqual(
    withSteering.items.map((item) => `${item.kind}:${item.text}`),
    ['user:Fix the failing test.', 'assistant:Done.'],
    'steering prompts never replay as user text'
  );
  // B251: the plan gate's auto-dispatch is a harness turn, not user words.
  const withPlanApproval = buildResumeReplay([
    { role: 'user', content: [{ type: 'text', text: 'Plan adding mul().' }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[System] The plan above is approved (version abc) — proceed with execution now.',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Adding it.' }] },
  ]);
  assert.deepEqual(
    withPlanApproval.items.map((item) => `${item.kind}:${item.text}`),
    ['user:Plan adding mul().', 'assistant:Adding it.'],
    'the plan gate dispatch never replays as user text'
  );
  // B231: a long tool turn collapses to one grouped line; a short one stays detailed.
  const toolUse = (name, input) => ({ type: 'tool_use', name, input });
  const longTurn = buildResumeReplay([
    { role: 'user', content: [{ type: 'text', text: 'Fix it.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        toolUse('read_file', { path: 'a.txt' }),
        toolUse('read_file', { path: 'b.txt' }),
        toolUse('exec', { command: 'node test.js' }),
        toolUse('read_file', { path: 'c.txt' }),
        toolUse('exec', { command: 'node test.js' }),
        toolUse('list_directory', { path: '.' }),
        toolUse('write_file', { path: 'c.txt' }),
      ],
    },
  ]);
  const longRows = longTurn.items.map((item) => `${item.kind}:${item.text}`);
  assert.equal(longRows.length, 3, 'long turn = user + prose + one grouped tool row');
  assert.match(longRows[2], /^system:⎿ 7 tool calls: Read ×3 · Exec ×2 · List Directory · Write$/);
  const shortTurn = buildResumeReplay([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        toolUse('read_file', { path: 'a.txt' }),
        toolUse('exec', { command: 'true' }),
      ],
    },
  ]);
  assert.deepEqual(
    shortTurn.items.map((item) => `${item.kind}:${item.text}`),
    ['assistant:Reading.', 'system:⎿ Read(a.txt)', 'system:⎿ Exec(true)'],
    'short turns keep per-call detail'
  );
  ok('a long replay turn groups its tool calls; a short one keeps detail');
}

// 7. B206: resume never picks an all-empty session as "the latest".
{
  const { resolveCliSession } = await import(dist('cli/session.js'));
  const meta = (key, messageCount, updatedAt) => ({ sessionKey: key, messageCount, updatedAt });
  const stub = (sessions) => ({
    listSessions: async () => sessions,
    exists: async (key) => sessions.some((session) => session.sessionKey === key),
    loadMessages: async () => [],
    replaceMessages: async () => {},
  });
  const mixed = await resolveCliSession({
    command: 'resume',
    store: stub([meta('empty', 0, 2000), meta('full', 3, 1000)]),
    useLast: true,
  });
  assert.equal(mixed.sessionKey, 'full', 'the newest non-empty session wins');
  const allEmpty = await resolveCliSession({
    command: 'resume',
    store: stub([meta('empty', 0, 2000)]),
    useLast: true,
  });
  assert.notEqual(allEmpty.sessionKey, 'empty');
  assert.match(allEmpty.notice ?? '', /starting a new session/);
  const explicit = await resolveCliSession({
    command: 'resume',
    store: stub([meta('empty', 0, 2000)]),
    sessionKey: 'empty',
  });
  assert.equal(explicit.sessionKey, 'empty', 'an explicit key is still honoured');
  ok('resume --last/--continue skips all-empty sessions');
}

// 8. B208: session export/search never show the injected turn context.
{
  const { InMemorySessionStore } = await import(dist('core/session/session.js'));
  const { countExportableSessionMessages, renderSessionMarkdown, searchSessions } = await import(
    dist('cli/command-dispatcher.js')
  );
  const preamble =
    'power export <turn-context>\n## Environment\n- Working directory: /tmp/x\n</turn-context>';
  const store = new InMemorySessionStore();
  await store.appendMessage('s1', {
    role: 'user',
    content: [{ type: 'text', text: preamble }],
    timestamp: Date.now(),
  });
  await store.appendMessage('s1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'Added power().' }],
    timestamp: Date.now(),
  });

  const markdown = renderSessionMarkdown('s1', await store.loadMessages('s1'));
  assert.match(markdown, /power export/);
  assert.doesNotMatch(markdown, /turn-context|## Environment/);

  const hit = (await searchSessions(store, 'power'))[0];
  assert.ok(hit, 'the user prompt is searchable');
  assert.doesNotMatch(hit.snippet, /<turn-context>|Environment/);
  assert.deepEqual(await searchSessions(store, 'Environment'), []);
  // B252: internal harness turns ([System] corrections/nudges, [Steering]) are
  // not conversation; the exported count reflects what is actually written.
  await store.appendMessage('s1', {
    role: 'user',
    content: [{ type: 'text', text: '[System] Long tool loop — pause and summarize.' }],
    timestamp: Date.now(),
  });
  await store.appendMessage('s1', {
    role: 'user',
    content: [{ type: 'text', text: '[Steering] Extended tool loop detected.' }],
    timestamp: Date.now(),
  });
  await store.appendMessage('s1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    timestamp: Date.now(),
  });
  const internalMarkdown = renderSessionMarkdown('s1', await store.loadMessages('s1'));
  assert.doesNotMatch(internalMarkdown, /\[System\]|\[Steering\]/);
  assert.match(internalMarkdown, /_3 message\(s\) · exported from moss\._/);
  assert.equal(countExportableSessionMessages(await store.loadMessages('s1')), 3);
  assert.deepEqual(await searchSessions(store, 'Long tool loop'), []);
  ok('session export/search strip internal [System] and [Steering] turns');
}

// 9. B209: `--out` (sessions/runs) is confined to the workspace.
{
  const { resolveExportOutPath } = await import(dist('cli/export-path.js'));
  assert.deepEqual(resolveExportOutPath('/tmp/ws', 'out/session.md'), {
    absolute: '/tmp/ws/out/session.md',
  });
  assert.deepEqual(resolveExportOutPath('/tmp/ws', 'session.md'), {
    absolute: '/tmp/ws/session.md',
  });
  assert.match(resolveExportOutPath('/tmp/ws', '../escape.md').error ?? '', /inside the workspace/);
  assert.match(resolveExportOutPath('/tmp/ws', '/tmp/abs.md').error ?? '', /inside the workspace/);
  ok('--out is confined to the workspace for session/run exports');

  // 10. B210: the in-session `/export <path>` uses the same confinement.
  const { findRegistryCommand } = await import(dist('cli/commands/registry.js'));
  const exportSpec = findRegistryCommand('/export')?.spec;
  assert.ok(exportSpec, '/export must be registered');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-export-'));
  const said = [];
  const ctx = {
    agent: {
      config: { sessionStore: { loadMessages: async () => [{ role: 'user', content: 'hi' }] } },
    },
    sessionKey: 's1',
    workspace: tmp,
    say: (kind, text) => said.push([kind, text]),
    prefillInput: () => {},
  };
  await exportSpec.run(ctx, '../escape.md');
  assert.equal(said.at(-1)[0], 'error');
  assert.match(said.at(-1)[1], /inside the workspace/);
  assert.equal(fs.existsSync(path.join(tmp, '..', 'escape.md')), false);
  await exportSpec.run(ctx, 'session.md');
  assert.match(fs.readFileSync(path.join(tmp, 'session.md'), 'utf8'), /## user/);
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('/export <path> stays inside the workspace');
}

// 11. B218: `sessions export --last` picks the newest non-empty session.
{
  const { JsonlSessionStore } = await import(dist('core/session/jsonl-session-store.js'));
  const { root: _root } = { root };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-sessions-last-'));
  const store = new JsonlSessionStore({ dir: path.join(tmp, '.moss', 'sessions') });
  await store.appendMessage('older', { role: 'user', content: 'older', timestamp: Date.now() });
  await store.appendMessage('older', { role: 'assistant', content: 'hi', timestamp: Date.now() });
  // A 0-message session file is newer by mtime but must not be chosen.
  const emptyPath = store.transcriptPath('empty');
  fs.writeFileSync(emptyPath, '');
  const newer = new Date(Date.now() + 5_000);
  fs.utimesSync(emptyPath, newer, newer);
  const cli = await captureProcess(
    process.execPath,
    [path.join(root, 'dist/cli.js'), 'sessions', 'export', '--last', '--out=-'],
    {
      cwd: tmp,
      env: {
        ...process.env,
        MOSS_LANG: 'en',
        MOSS_NO_TUI: '1',
        MOSS_CONFIG_DIR: path.join(tmp, 'cfg'),
      },
      timeoutMs: 30_000,
    }
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^# Session older/);
  fs.rmSync(tmp, { recursive: true, force: true });
  ok('sessions export --last exports the newest non-empty session');
}

console.log(`[rewind-conversation] ${checks}/${checks} checks passed`);
