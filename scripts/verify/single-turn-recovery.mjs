import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.MOSS_VERIFY_DIST_ROOT ?? path.resolve('dist');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { appendShellContinueHint } = await load('safety/shell-soft-failure-hint.js');
const { VersionedSessionStore } = await load('core/session/versioned-session-store.js');
const { VersionedContextPipeline } = await load('core/session/versioned-context.js');
const optional = 'files=4 bytes=187\nls: .moss: No such file or directory';
assert.equal(appendShellContinueHint('shell', optional), optional);
assert.equal(
  appendShellContinueHint('shell', optional + '\n[EXIT CODE] 0'),
  optional + '\n[EXIT CODE] 0'
);
for (const outcome of ['ok', 'denied', 'blocked', 'suppressed', 'replayed'])
  assert.equal(appendShellContinueHint('exec', '[EXIT CODE] 1', { outcome }), '[EXIT CODE] 1');
assert.equal(appendShellContinueHint('exec', '[EXIT CODE] 1', { exitCode: 0 }), '[EXIT CODE] 1');
assert.equal(
  appendShellContinueHint('exec', 'quoted [EXIT CODE] 1 then handled'),
  'quoted [EXIT CODE] 1 then handled'
);
const failure = appendShellContinueHint('shell', '[EXIT CODE] 1');
assert.notEqual(failure, '[EXIT CODE] 1');
assert.doesNotMatch(failure, /必须|禁止/);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-single-turn-'));
const store = new VersionedSessionStore(path.join(dir, 'context.sqlite'));
try {
  const session = 'single';
  const add = (message, origin) => store.appendMessage(session, message, origin);
  await add(
    {
      role: 'user',
      content: 'Summarize only these four files. No writes or memory.',
      timestamp: 0,
    },
    'user'
  );
  for (let i = 0; i < 8; i++) {
    await add(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `c${i}`, name: 'read', input: {} }],
        thinking: ['reasoning '.repeat(2000)],
        timestamp: i,
      },
      'assistant'
    );
    await add(
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `c${i}`,
            name: 'read',
            content: `file-${i}: observed`,
          },
        ],
        timestamp: i,
      },
      'tool'
    );
  }
  await add(
    {
      role: 'user',
      content: '[Runtime authorization: read only; memory_save denied]',
      timestamp: 9,
    },
    'runtime'
  );
  const original = await store.sourceMessages(session);
  let summaries = 0;
  const pipeline = new VersionedContextPipeline(store);
  const input = {
    sessionKey: session,
    window: 1000000,
    output: 1024,
    minOutput: 1024,
    policyKey: 'probe',
    signal: AbortSignal.timeout(10000),
    measure: (m) => JSON.stringify(m).length,
    summarize: async () => {
      summaries++;
      return '[]';
    },
  };
  await pipeline.prepare(input);
  assert.equal(summaries, 0);
  const projected = await pipeline.prepare({ ...input, force: true });
  assert(projected.stages.includes('S5'), 'single active turn must summarize completed rounds');
  assert.equal(summaries, 1);
  assert(JSON.stringify(projected.messages).length < JSON.stringify(original).length / 2);
  assert.match(JSON.stringify(projected.messages), /No writes or memory/);
  const { convertMessages } = await load('provider/pi-ai-wire-format.js');
  for (const thinkingMode of [false, true]) {
    const wire = convertMessages(
      projected.messages,
      { id: 'offline', provider: 'custom', api: 'openai-completions' },
      thinkingMode
    );
    const assistant = wire.findLast((message) => message.role === 'assistant');
    assert(
      assistant.content.some(
        (block) => block.type === 'thinking' && block.thinkingSignature === 'reasoning_content'
      )
    );
  }
  const blocks = projected.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  for (const block of blocks.filter((b) => b.type === 'tool_use'))
    assert(blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === block.id));
  assert(blocks.some((b) => b.tool_use_id === 'c7' && b.content === 'file-7: observed'));
  assert(projected.messages.some((m) => m.thinking?.[0] === original.at(-3).message.thinking[0]));
  assert.match(JSON.stringify(projected.messages), /memory_save denied/);
  assert.deepEqual(await store.sourceMessages(session), original);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(pipeline.prepare({ ...input, force: true, signal: cancelled.signal }));
  await store.appendMessage('foreign', { role: 'user', content: 'FOREIGN_SECRET' }, 'user');
  assert.doesNotMatch(JSON.stringify(await pipeline.prepare(input)), /FOREIGN_SECRET/);
  await add(
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'pending', name: 'read', input: {} }],
      thinking: ['pending-reasoning'],
      timestamp: 10,
    },
    'assistant'
  );
  const pending = await pipeline.prepare({
    ...input,
    force: true,
    summarize: async () => {
      throw new Error('summary unavailable');
    },
  });
  assert.match(JSON.stringify(pending.messages), /pending-reasoning/);
  assert.match(JSON.stringify(pending.messages), /"id":"pending"/);
  await assert.rejects(pipeline.prepare({ ...input, measure: () => 2000000, force: true }), {
    code: 'PROVIDER_CONTEXT_OVERFLOW',
  });
  console.log(
    'PASS optional probes, single-turn summary, recent reasoning/pairs, archive and bounded overflow'
  );
} finally {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
}

// Real HTTP serializer + real agent loop: reject the generation after tool work.
const http = await import('node:http');
const { MossAgent } = await load('core/agent/moss-agent.js');
const { PiAiLLMProvider } = await load('provider/pi-ai-adapter.js');
const { createHttpStreamFunction } = await load('provider/pi-ai-http-transport.js');
for (const persistent of [false, true]) {
  let requests = 0;
  let writes = 0;
  const sizes = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (raw.includes('Summarize the supplied historical data')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            { index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' },
          ],
        })
      );
      return;
    }
    requests++;
    sizes.push(raw.length);
    res.setHeader('Content-Type', 'application/json');
    if (requests === 4 || (persistent && requests >= 4)) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: {
            message: 'context_length_exceeded',
            code: 'gateway_auto_context_overflow',
            source: 'gateway',
          },
        })
      );
      return;
    }
    const tool = requests < 4;
    res.end(
      JSON.stringify({
        id: 'offline',
        object: 'chat.completion',
        model: 'offline',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: tool ? null : 'Four files inspected; damaged text cannot be recovered.',
              ...(tool
                ? {
                    reasoning_content: 'reason '.repeat(3000),
                    tool_calls: [
                      {
                        id: `r${requests}`,
                        type: 'function',
                        function: {
                          name: 'probe_fixture',
                          arguments: JSON.stringify({ index: requests }),
                        },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: tool ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    assert(body.messages.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-http-overflow-'));
  const sessions = new VersionedSessionStore(path.join(workspace, 'sessions.sqlite'));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const agent = new MossAgent({
    llmProvider: new PiAiLLMProvider({
      apiKey: 'offline',
      model: { id: 'offline', api: 'openai-completions', provider: 'custom', baseUrl },
      streamFn: createHttpStreamFunction({
        providerLabel: 'offline',
        apiKey: 'offline',
        model: 'offline',
        baseUrl,
      }),
    }),
    sessionStore: sessions,
    workspaceDir: workspace,
    taskIntent: false,
    contextTokens: 1000000,
    maxTokens: 1024,
    baseSystemPrompt: 'Summarize the four fixture files.',
    domainPrompt: false,
    verificationGate: false,
  });
  agent.tools.register({
    name: 'probe_fixture',
    description: 'Return synthetic inspection data',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute() {
      writes++;
      return (
        'Four files, 187 bytes; test marker; irreversibly damaged text. ' + 'data '.repeat(4000)
      );
    },
  });
  try {
    if (persistent)
      await assert.rejects(
        agent.chat('fixture', 'Summarize this project; no memory writes.'),
        (error) => {
          assert.equal(error.code, 'PROVIDER_CONTEXT_OVERFLOW');
          assert.equal(error.source, 'gateway');
          assert.equal(error.providerCode, 'gateway_auto_context_overflow');
          return true;
        }
      );
    else {
      const reply = await agent.chat('fixture', 'Summarize this project; no memory writes.');
      assert.match(reply.response, /Four files inspected/);
    }
    assert.equal(requests, 5);
    assert.equal(writes, 3, 'completed tools must never replay during recovery');
    assert(sizes[4] < sizes[3], 'overflow retry must serialize a smaller projection');
  } finally {
    await agent.close();
    sessions.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
console.log(
  'PASS real HTTP serialization and agent loop recover once or fail after a second rejection'
);

await import('./provider-error-identity.mjs');
