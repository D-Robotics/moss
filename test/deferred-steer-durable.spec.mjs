import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const source = process.env.MOSS_TEST_SOURCE === '1';
const modulePath = (name) => `../${source ? 'src' : 'dist'}/${name}.${source ? 'ts' : 'js'}`;
const { MossAgent } = await import(modulePath('core/agent/moss-agent'));
const { JsonlSessionStore } = await import(modulePath('core/session/jsonl-session-store'));
const { InMemorySessionStore } = await import(modulePath('core/session/session'));
const { runProcess } = await import(modulePath('utils/run-process'));
const { loadSessionInbox, updateSessionInbox } = await import(
  modulePath('core/session/session-inbox-store')
);
const fsSync = (await import('node:fs')).default;

const user = (content) => ({ role: 'user', content });
const users = (messages) =>
  messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
    );

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-durable-steer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function provider(blocked = false) {
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const requests = [];
  return {
    ready,
    requests,
    id: 'durable-steer-test',
    displayName: 'durable-steer-test',
    async stream(options, onEvent) {
      requests.push(options.messages);
      entered();
      if (blocked)
        await new Promise((_resolve, reject) => {
          const fail = () => reject(new Error('aborted'));
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener('abort', fail, { once: true });
        });
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'ok' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function agent(
  t,
  workspaceDir,
  llmProvider,
  sessionStore = new JsonlSessionStore({ dir: path.join(workspaceDir, 'sessions') })
) {
  const value = new MossAgent({
    workspaceDir,
    sessionStore,
    llmProvider,
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
  });
  t.after(() => value.close());
  return value;
}

async function leaveDeferred(t, dir, key, text) {
  const llm = provider(true);
  const value = agent(t, dir, llm);
  const controller = new AbortController();
  const run = value.chat(key, 'first', { abortSignal: controller.signal });
  await llm.ready;
  const admitted = value.steer(key, text);
  assert.ok(admitted);
  controller.abort();
  await run.catch(() => {});
  await value.close();
  return admitted;
}

for (const kind of ['memory', 'jsonl'])
  test(`${kind} append-once is scoped by delivery ID and survives replacement`, async (t) => {
    const dir = await temporary(t);
    const store = kind === 'memory' ? new InMemorySessionStore() : new JsonlSessionStore({ dir });
    assert.equal(typeof store.appendMessageOnce, 'function');
    assert.equal(
      await store.appendMessageOnce('owner-a:session', 'delivery-1', user('same body')),
      true
    );
    assert.equal(
      await store.appendMessageOnce('owner-a:session', 'delivery-1', user('same body')),
      false
    );
    assert.equal(
      await store.appendMessageOnce('owner-a:session', 'delivery-2', user('same body')),
      true
    );
    assert.deepEqual(users(await store.loadMessages('owner-a:session')), [
      'same body',
      'same body',
    ]);
    await store.replaceMessages('owner-a:session', [user('compacted')]);
    const restarted = kind === 'memory' ? store : new JsonlSessionStore({ dir });
    assert.equal(
      await restarted.appendMessageOnce('owner-a:session', 'delivery-1', user('same body')),
      false
    );
    assert.deepEqual(users(await restarted.loadMessages('owner-a:session')), ['compacted']);
    assert.equal(
      await restarted.appendMessageOnce('owner-b:session', 'delivery-1', user('same body')),
      true
    );
    await restarted.deleteSession('owner-a:session');
    assert.equal(
      await restarted.appendMessageOnce('owner-a:session', 'delivery-1', user('new session')),
      true
    );
  });

test('independent Agents retain deferred steer without owner/session leakage', async (t) => {
  const dir = await temporary(t);
  const key = 'owner-a:session';
  await leaveDeferred(t, dir, key, 'durable constraint');
  for (const unrelated of ['owner-b:session', 'owner-a:another']) {
    const llm = provider();
    await agent(t, dir, llm).chat(unrelated, 'next');
    assert.equal(
      users(llm.requests.at(-1)).filter((text) => text === 'durable constraint').length,
      0
    );
  }
  const llm = provider();
  const next = agent(t, dir, llm);
  await next.chat(key, 'next');
  const texts = users(llm.requests.at(-1));
  assert.equal(texts.filter((text) => text === 'durable constraint').length, 1);
  assert.ok(texts.indexOf('durable constraint') < texts.findIndex((text) => text.includes('next')));
  assert.equal(next.inboxPending(key).length, 0);
  await next.chat(key, 'again');
  assert.equal(
    users(llm.requests.at(-1)).filter((text) => text === 'durable constraint').length,
    1
  );
});

test('append committed before lost acknowledgement is retried without duplication', async (t) => {
  const dir = await temporary(t);
  const key = 'owner-a:session';
  await leaveDeferred(t, dir, key, 'ack crash constraint');
  const durable = new JsonlSessionStore({ dir: path.join(dir, 'sessions') });
  assert.equal(typeof durable.appendMessageOnce, 'function');
  const append = durable.appendMessageOnce.bind(durable);
  durable.appendMessageOnce = async (...args) => {
    await append(...args);
    throw new Error('simulated stop after durable append before inbox acknowledgement');
  };
  await assert.rejects(
    agent(t, dir, provider(), durable).chat(key, 'interrupted'),
    /after durable append/
  );
  const llm = provider();
  await agent(t, dir, llm).chat(key, 'retry');
  assert.equal(
    users(llm.requests.at(-1)).filter((text) => text === 'ack crash constraint').length,
    1
  );
});

test('two process restart rounds carry one copy and isolate owner/session', async (t) => {
  const dir = await temporary(t);
  const child = async (mode, key, text, hardStop = false) => {
    const agentModule = new URL(modulePath('core/agent/moss-agent'), import.meta.url).href;
    const storeModule = new URL(modulePath('core/session/jsonl-session-store'), import.meta.url)
      .href;
    const program = `
      import { MossAgent } from ${JSON.stringify(agentModule)};
      import { JsonlSessionStore } from ${JSON.stringify(storeModule)};
      const provider = ${provider.toString()};
      const users = ${users.toString()};
      const llm = provider(${mode === 'admit'});
      const key = ${JSON.stringify(key)};
      const text = ${JSON.stringify(text)};
      const value = new MossAgent({ workspaceDir: ${JSON.stringify(dir)}, sessionStore: new JsonlSessionStore({ dir: ${JSON.stringify(path.join(dir, 'sessions'))} }), llmProvider: llm, baseSystemPrompt: 'test', domainPrompt: false, includeAgentBehaviorPrompt: false, includeLanguagePolicyPrompt: false, enableSteering: false, enableFollowUpGuard: false, maxAgentTurns: 2 });
      if (${mode === 'admit'}) {
        const controller = new AbortController();
        const run = value.chat(key, 'first', { runId: 'terminated-run', abortSignal: controller.signal });
        await llm.ready;
        if (!value.steer(key, text)) throw new Error('steer was not admitted');
        if (${hardStop}) process.exit(0);
        controller.abort();
        await run.catch(() => {});
      } else {
        if (${hardStop}) value.recoverDeferredSteers(key, ['terminated-run']);
        await value.chat(key, 'next');
        const first = users(llm.requests.at(-1)).filter((item) => item === text).length;
        await value.chat(key, 'again');
        const second = users(llm.requests.at(-1)).filter((item) => item === text).length;
        console.log(JSON.stringify({ first, second }));
      }
      await value.close();
    `;
    const result = await runProcess(process.execPath, {
      args: [...process.execArgv, '--input-type=module', '--eval', program],
      timeout: 20_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    if (mode !== 'admit') return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  for (const hardStop of [false, true]) {
    const key = `owner-a:restart-${Number(hardStop)}`;
    const text = `restart constraint ${Number(hardStop)}`;
    await child('admit', key, text, hardStop);
    assert.deepEqual(await child('resume', `owner-b:restart-${Number(hardStop)}`, text), {
      first: 0,
      second: 0,
    });
    assert.deepEqual(await child('resume', 'owner-a:unrelated', text), { first: 0, second: 0 });
    assert.deepEqual(await child('resume', key, text, hardStop), { first: 1, second: 1 });
  }
});

test('failed append does not acknowledge a deferred delivery', async (t) => {
  const dir = await temporary(t);
  const key = 'owner-a:session';
  const entry = await leaveDeferred(t, dir, key, 'retry after failed append');
  const store = new JsonlSessionStore({ dir: path.join(dir, 'sessions') });
  store.appendMessageOnce = async () => {
    throw new Error('disk unavailable');
  };
  const interrupted = agent(t, dir, provider(), store);
  await assert.rejects(interrupted.chat(key, 'next'), /disk unavailable/);
  assert.equal(
    interrupted.inboxPending(key).some((pending) => pending.id === entry.id),
    true
  );
  const llm = provider();
  await agent(t, dir, llm).chat(key, 'retry');
  assert.equal(
    users(llm.requests.at(-1)).filter((text) => text === 'retry after failed append').length,
    1
  );
});

test('durable continuation is requested only for a deferred handoff and failure keeps it pending', async (t) => {
  const dir = await temporary(t);
  const key = 'owner-a:session';
  const store = new JsonlSessionStore({ dir: path.join(dir, 'sessions') });
  let adoptions = 0;
  store.ensureDurableSession = async () => {
    adoptions++;
    throw new Error('capture failed');
  };
  await agent(t, dir, provider(), store).chat(key, 'ordinary');
  assert.equal(adoptions, 0);
  const entry = await leaveDeferred(t, dir, key, 'needs durable adoption');
  assert.equal(entry.metadata.producer.host, os.hostname());
  assert.equal(entry.metadata.producer.pid, process.pid);
  assert.equal(typeof entry.metadata.producer.instanceId, 'string');
  const pending = agent(t, dir, provider(), store);
  await assert.rejects(pending.chat(key, 'next'), /capture failed/);
  assert.equal(adoptions, 1);
  assert.equal(
    pending.inboxPending(key).some((item) => item.id === entry.id),
    true
  );
});

test('in-run steering is acknowledged only after append-once and survives a lost acknowledgement', async (t) => {
  const dir = await temporary(t);
  const key = 'owner-a:session';
  const store = new JsonlSessionStore({ dir: path.join(dir, 'sessions') });
  const append = store.appendMessageOnce.bind(store);
  let committed;
  store.appendMessageOnce = async (...args) => {
    committed = args[1];
    await append(...args);
    throw new Error('in-run acknowledgement interrupted');
  };
  let calls = 0;
  const llm = provider();
  llm.stream = async (_options, onEvent) => {
    calls++;
    const response =
      calls === 1
        ? {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: 'inspect-1', name: 'inspect', input: {} }],
          }
        : { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    onEvent({ type: 'message_start' });
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        onEvent({ type: 'content_block_start', toolUse: { id: block.id, name: block.name } });
        onEvent({ type: 'content_block_delta', partialJson: '{}' });
      } else {
        onEvent({ type: 'content_block_start' });
        onEvent({ type: 'content_block_delta', text: block.text });
      }
      onEvent({ type: 'content_block_stop' });
    }
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  };
  const first = agent(t, dir, llm, store);
  let entry;
  first.tools.register({
    name: 'inspect',
    description: 'inspect',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      entry = first.steer(key, 'live steering constraint');
      return 'done';
    },
  });
  await assert.rejects(first.chat(key, 'inspect'), /in-run acknowledgement interrupted/);
  assert.equal(committed, entry.id, 'the internal message keeps its original delivery identity');
  assert.equal(
    first.inboxPending(key).some((item) => item.id === entry.id),
    true
  );
  const resumed = provider();
  await agent(t, dir, resumed).chat(key, 'resume');
  assert.equal(
    users(resumed.requests.at(-1)).filter((text) => text.includes('live steering constraint'))
      .length,
    1
  );
});

test('inbox corruption and pre-commit persistence failures cannot look like successful admission', async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, 'inbox.json');
  await fs.writeFile(file, '{bad json');
  assert.throws(() => loadSessionInbox(file));
  await fs.rm(file);
  updateSessionInbox(file, (inbox) => inbox.admit({ id: 'existing', prompt: 'keep' }));
  const rename = fsSync.renameSync;
  try {
    fsSync.renameSync = (from, to) => {
      if (to === file) throw new Error('rename before commit failed');
      return rename(from, to);
    };
    assert.throws(
      () => updateSessionInbox(file, (inbox) => inbox.admit({ id: 'not-admitted', prompt: 'new' })),
      /before commit failed/
    );
  } finally {
    fsSync.renameSync = rename;
  }
  assert.deepEqual(
    loadSessionInbox(file)
      .pending()
      .map((entry) => entry.id),
    ['existing']
  );
  updateSessionInbox(file, (inbox) => inbox.admit({ id: 'retry', prompt: 'works' }));
  assert.deepEqual(
    loadSessionInbox(file)
      .pending()
      .map((entry) => entry.id),
    ['existing', 'retry']
  );
});

test('a receipt retry does not authorize replacement from a stale history view', async (t) => {
  const dir = await temporary(t);
  const first = new JsonlSessionStore({ dir });
  await first.appendMessageOnce('session', 'delivery-1', user('base'));
  const stale = new JsonlSessionStore({ dir });
  await stale.loadMessages('session');
  await first.appendMessage('session', user('concurrent addition'));
  assert.equal(await stale.appendMessageOnce('session', 'delivery-1', user('base')), false);
  await assert.rejects(
    stale.replaceMessages('session', [user('stale compacted')]),
    /Session changed before replacement/
  );
  assert.deepEqual(users(await first.loadMessages('session')), ['base', 'concurrent addition']);
});

test('durable inbox refresh preserves queued work admitted during an explicit drain', async (t) => {
  const dir = await temporary(t);
  const llm = provider();
  const original = llm.stream.bind(llm);
  let value;
  let calls = 0;
  llm.stream = async (...args) => {
    if (calls++ === 0) value.admit('queue', 'second queued prompt', { delivery: 'queue' });
    return original(...args);
  };
  value = agent(t, dir, llm);
  value.admit('queue', 'first queued prompt', { delivery: 'queue' });
  const result = await value.drainInbox('queue');
  assert.equal(result.chats.length, 2);
  assert.equal(value.inboxPending('queue').length, 0);
});
