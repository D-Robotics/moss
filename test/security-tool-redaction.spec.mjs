import assert from 'node:assert/strict';
import test from 'node:test';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { ErrorCode, MossError } from '../dist/errors.js';
import { PiAiLLMProvider } from '../dist/provider/pi-ai-adapter.js';

const fakeToken = `sk-${'B'.repeat(32)}`;
const privateValue = 'synthetic-hook-private-value';
const opaquePassword = 'sYn7heticP4ssW0rd98';

function containsValue(value, needle, seen = new Set()) {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsValue(value[key], needle, seen));
}

async function runTool({
  executeStructured,
  redact = false,
  lateHook = false,
  sameTextHook = false,
}) {
  const store = new InMemorySessionStore();
  const observed = [];
  let calls = 0;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: { api: 'openai-completions', provider: 'test', id: 'test-model' },
    streamFn: async function* () {
      if (calls++ === 0) {
        yield {
          type: 'toolcall_end',
          toolCall: { id: 'fixture-1', name: 'fixture', arguments: {} },
        };
        yield { type: 'done', stopReason: 'toolUse' };
      } else {
        yield { type: 'text_delta', delta: 'done' };
        yield { type: 'done', stopReason: 'stop' };
      }
    },
  });
  const agent = new MossAgent({
    llmProvider: provider,
    model: 'test-model',
    sessionStore: store,
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    hooks: {
      onBeforeToolExec: async () => ({ approved: true }),
      onToolResult: (_call, result) => observed.push(result),
    },
  });
  if (redact) {
    agent.registerPostToolHook({
      name: 'fixture-redaction',
      priority: 1,
      async process() {
        return { result: 'public failure' };
      },
    });
  }
  if (lateHook) {
    agent.registerPostToolHook({
      name: 'late-fixture-hook',
      priority: 20,
      async process() {
        return { result: `public failure ${fakeToken}` };
      },
    });
  }
  if (sameTextHook) {
    agent.registerPostToolHook({
      name: 'secret-sanitizer',
      priority: 20,
      async process({ result }) {
        return { result };
      },
    });
  }
  agent.tools.register({
    name: 'fixture',
    description: 'Return local synthetic data.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly', noReplay: true },
    execute: async () => assert.fail('structured execution is required'),
    executeStructured,
  });
  try {
    const events = [];
    for await (const event of agent.streamChat('redaction-fixture', 'Use the fixture.')) {
      events.push(event);
    }
    assert.equal(calls, 2);
    assert.equal(observed.length, 1);
    const end = events.find((event) => event.type === 'tool_end');
    assert.ok(end);
    return {
      end,
      observed: observed[0],
      events,
      messages: await store.loadMessages('redaction-fixture'),
    };
  } finally {
    await agent.close();
  }
}

test('rewritten structured failures cannot leak through tool errors or SDK callbacks', async () => {
  const result = await runTool({
    redact: true,
    executeStructured: async () => ({
      isError: true,
      content: [{ type: 'text', text: `failed: ${privateValue}` }],
    }),
  });
  assert.equal(result.end.content, 'public failure');
  assert.equal(result.end.error?.code, ErrorCode.TOOL_EXECUTION_FAILED);
  assert.equal(result.end.error?.message, 'public failure');
  assert.equal(containsValue(result.events, privateValue), false);
  assert.equal(containsValue(result.observed, privateValue), false);
});

test('rewritten failures preserve a safe cause chain without exposing original context', async () => {
  const result = await runTool({
    redact: true,
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `failed: ${privateValue}`,
        hint: `hint: ${privateValue}`,
        context: { nested: { details: privateValue } },
        cause: new Error(`inner: ${privateValue}`, { cause: new Error('root cause') }),
      });
    },
  });
  assert.equal(result.end.error?.code, ErrorCode.TOOL_EXECUTION_FAILED);
  assert.ok(result.end.error?.cause, 'the causal chain remains observable');
  assert.ok(result.end.error.cause.cause, 'nested causes remain observable');
  assert.equal(containsValue(result.events, privateValue), false);
  assert.equal(containsValue(result.observed, privateValue), false);
});

test('unmodified failures keep useful safe cause details while redacting credentials', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed to parse resource',
        hint: 'check the format',
        context: { stage: 'parse', credential: fakeToken },
        cause: new Error(`invalid value ${fakeToken}`, { cause: new Error('decoder failed') }),
      });
    },
  });
  assert.equal(result.end.error?.message, 'failed to parse resource');
  assert.equal(result.end.error?.hint, 'check the format');
  assert.equal(result.end.error?.context?.stage, 'parse');
  assert.match(result.end.error?.cause?.message, /invalid value/);
  assert.equal(result.end.error?.cause?.cause?.message, 'decoder failed');
  assert.equal(containsValue(result.events, fakeToken), false);
  assert.equal(containsValue(result.observed, fakeToken), false);
});

test('sensitive image data is withheld without discarding safe resources', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'image', data: fakeToken, mimeType: 'image/png' },
        { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, fakeToken), false);
  assert.equal(result.end.structuredContent[0].type, 'text');
  assert.match(result.end.structuredContent[0].text, /image.*withheld/i);
  assert.deepEqual(result.end.structuredContent[1], {
    type: 'resource',
    uri: 'fixture://safe/guide',
    name: 'safe guide',
  });
});

test('credential fields and non-text values in error context do not bypass redaction', async () => {
  const callback = Object.assign(() => {}, { value: privateValue });
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failure with diagnostic context',
        context: {
          stage: 'parse',
          password: opaquePassword,
          secretKey: opaquePassword,
          bytes: Buffer.from(privateValue),
          callback,
        },
      });
    },
  });
  const context = result.end.error.context;
  assert.equal(context.stage, 'parse');
  assert.equal(JSON.stringify(context).includes(opaquePassword), false);
  assert.equal(typeof context.bytes, 'string');
  assert.equal(typeof context.callback, 'string');
  assert.equal(containsValue(result.observed, opaquePassword), false);
});

test('error context arrays cannot override the redaction traversal', async () => {
  const items = ['safe'];
  Object.defineProperty(items, 'map', { value: () => [{ password: opaquePassword }] });
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed',
        context: { items },
      });
    },
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.deepEqual(result.end.error.context.items, ['safe']);
});

test('a throwing cause accessor cannot bypass a hook replacement', async () => {
  const result = await runTool({
    redact: true,
    executeStructured: async () => {
      const error = new MossError({ code: ErrorCode.TOOL_EXECUTION_FAILED, message: 'failed' });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error(privateValue);
        },
      });
      throw error;
    },
  });
  assert.equal(result.end.content, 'public failure');
  assert.equal(containsValue(result.events, privateValue), false);
  assert.equal(containsValue(result.observed, privateValue), false);
});

test('a late post-hook cannot reintroduce credentials into error events or callbacks', async () => {
  const result = await runTool({
    lateHook: true,
    executeStructured: async () => ({
      isError: true,
      content: [{ type: 'text', text: 'safe failure' }],
    }),
  });
  assert.equal(containsValue(result.events, fakeToken), false);
  assert.equal(containsValue(result.observed, fakeToken), false);
  assert.match(result.end.content, /public failure/);
});

test('a shared cause remains observable when also referenced by context', async () => {
  const cause = new Error('decoder failed');
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'parse failed',
        context: { source: cause },
        cause,
      });
    },
  });
  assert.equal(result.end.error.cause.message, 'decoder failed');
  assert.equal(result.end.error.context.source.message, 'decoder failed');
});

test('built-in redaction preserves safe image and resource blocks without split-secret leakage', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'Authorization: Bearer' },
        { type: 'text', text: opaquePassword },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
        { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
  const image = result.end.structuredContent?.find((block) => block.type === 'image');
  const resource = result.end.structuredContent?.find((block) => block.type === 'resource');
  assert.equal(image?.data, 'AAECAw==');
  assert.equal(resource?.uri, 'fixture://safe/guide');
  const stored = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === 'tool_result');
  assert.equal(
    stored?.structuredContent?.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
  assert.equal(
    stored?.structuredContent?.find((block) => block.type === 'resource')?.uri,
    'fixture://safe/guide'
  );
});

test('a host hook with the sanitizer name still strips same-text structured output', async () => {
  const result = await runTool({
    sameTextHook: true,
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'safe observation' },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
      ],
    }),
  });
  assert.equal(result.end.content, 'safe observation');
  assert.equal(result.end.structuredContent, undefined);
  assert.equal(result.observed.structuredContent, undefined);
  const stored = result.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  );
  assert.equal(stored.find((block) => block.type === 'tool_result')?.structuredContent, undefined);
});

test('credentials recognized in text are not repeated in image or resource metadata', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `Authorization: Bearer ${opaquePassword}` },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png', alt: `view ${opaquePassword}` },
        {
          type: 'resource',
          uri: `fixture://guide/${opaquePassword}`,
          name: `guide ${opaquePassword}`,
        },
        { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
      ],
    }),
  });
  assert.equal(result.end.content.includes(opaquePassword), false);
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
  const image = result.end.structuredContent?.find((block) => block.type === 'image');
  const safe = result.end.structuredContent?.find((block) => block.uri === 'fixture://safe/guide');
  assert.equal(image?.data, 'AAECAw==');
  assert.equal(safe?.name, 'safe guide');
});

test('recognized credentials do not remain in later text or metadata', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        {
          type: 'text',
          text: `Authorization: Bearer ${opaquePassword}\nRepeated: ${opaquePassword}`,
        },
        { type: 'resource', uri: `fixture://guide/${opaquePassword}` },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
});

test('already-redacted text withholds unverified metadata but preserves safe image data', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'Authorization: Bearer [REDACTED]' },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png', alt: opaquePassword },
        { type: 'resource', uri: `fixture://guide/${opaquePassword}`, name: opaquePassword },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
  assert.equal(
    result.end.structuredContent.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
  assert.equal(
    result.end.structuredContent.find((block) => block.type === 'resource')?.uri,
    '[REDACTED]'
  );
});

test('structured arrays cannot override the SDK redaction traversal', async () => {
  const content = [{ type: 'text', text: 'safe observation' }];
  Object.defineProperty(content, 'map', {
    value: () => [{ type: 'resource', uri: `fixture://guide/${fakeToken}` }],
  });
  const result = await runTool({ executeStructured: async () => ({ content }) });
  assert.equal(containsValue(result.events, fakeToken), false);
  assert.equal(containsValue(result.observed, fakeToken), false);
  assert.equal(containsValue(result.messages, fakeToken), false);
  assert.equal(result.end.content, 'safe observation');
});

test('error contexts redact raw headers and attached curl credentials', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed safely',
        context: {
          rawHeaders: ['Authorization', `Bearer ${opaquePassword}`, 'Content-Type', 'text/plain'],
          argv: ['curl', `--user=alice:${opaquePassword}`],
        },
      });
    },
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.ok(result.end.error?.cause === undefined);
});

test('ordinary diagnostic arrays are not treated as command arguments', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed safely',
        context: {
          lines: ['-p', 'robot-port = 2222'],
          logLines: ['curl', '-p', 'robot-port = 2222'],
        },
      });
    },
  });
  assert.deepEqual(result.end.error.context.lines, ['-p', 'robot-port = 2222']);
  assert.deepEqual(result.end.error.context.logLines, ['curl', '-p', 'robot-port = 2222']);
});

test('SDK metadata redacts encoded values beside invalid UTF-8 escapes', async () => {
  const encoded = Array.from(opaquePassword, (char) => `%${char.charCodeAt(0).toString(16)}`).join(
    ''
  );
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `Authorization: Bearer ${opaquePassword}` },
        { type: 'resource', uri: `fixture://guide/%FF/${encoded}` },
        { type: 'resource', uri: `fixture://guide/%ff${encoded}` },
        { type: 'resource', uri: 'fixture://safe/guide' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, encoded), false);
  assert.equal(containsValue(result.observed, encoded), false);
  assert.equal(containsValue(result.messages, encoded), false);
  assert.ok(result.end.structuredContent.some((block) => block.uri === 'fixture://safe/guide'));
});

test('SDK error contexts preserve nested header-pair context', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed safely',
        context: {
          headers: [
            ['Authorization', `Bearer ${opaquePassword}`],
            ['Content-Type', 'text/plain'],
          ],
        },
      });
    },
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(result.end.error.context.headers[1][1], 'text/plain');
});

test('SDK error contexts redact attached mysql and sshpass passwords', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'failed safely',
        context: {
          mysql: ['mysql', `-p${opaquePassword}`],
          sshpass: ['sshpass', `-p${opaquePassword}`],
          lines: ['-p2222', 'safe diagnostic'],
        },
      });
    },
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.deepEqual(result.end.error.context.lines, ['-p2222', 'safe diagnostic']);
});

test('SDK output redacts quoted passwords repeated elsewhere', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `password="${opaquePassword}"\nRepeated: ${opaquePassword}` },
        { type: 'resource', uri: 'fixture://safe/guide' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
});

test('SDK output does not repeat quoted passwords containing symbols', async () => {
  const token = 'Sy!n7heticP4ss&98';
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `password="${token}"\nRepeated: ${token}` },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, token), false);
  assert.equal(containsValue(result.observed, token), false);
  assert.equal(containsValue(result.messages, token), false);
  assert.equal(
    result.end.structuredContent?.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
});

test('SDK output does not repeat escaped quoted password values', async () => {
  const token = 'Sy"n7heticP4ss98';
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `password=${JSON.stringify(token)}\nRepeated: ${token}` },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, token), false);
  assert.equal(containsValue(result.observed, token), false);
  assert.equal(containsValue(result.messages, token), false);
  assert.equal(
    result.end.structuredContent?.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
});

test('SDK withholds text when a quoted secret cannot be safely decoded', async () => {
  const token = 'Sy\\q7heticP4ss98';
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: `password='${token}'\nRepeated: ${token}` },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
      ],
    }),
  });
  assert.equal(containsValue(result.events, token), false);
  assert.equal(containsValue(result.observed, token), false);
  assert.equal(containsValue(result.messages, token), false);
  assert.equal(
    result.end.structuredContent?.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
});

test('SDK metadata does not repeat a quoted credential within one field', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'safe observation' },
        {
          type: 'resource',
          uri: 'fixture://safe/guide',
          name: `password="${opaquePassword}"\nRepeated: ${opaquePassword}`,
        },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
});

test('SDK keeps labelled star masks conservative for unverified metadata', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'password=***' },
        { type: 'resource', uri: `fixture://guide/${opaquePassword}`, name: opaquePassword },
      ],
    }),
  });
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
  assert.equal(
    result.end.structuredContent.find((block) => block.type === 'resource')?.uri,
    '[REDACTED]'
  );
});

test('SDK keeps safe resources after ordinary Markdown stars', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: '# Password\n\n***\n\nDetails' },
        { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
      ],
    }),
  });
  const resource = result.end.structuredContent.find((block) => block.type === 'resource');
  assert.equal(resource?.uri, 'fixture://safe/guide');
  assert.equal(resource?.name, 'safe guide');
});

test('structured metadata is redacted in SDK events and in-memory history', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'safe observation' },
        {
          type: 'resource',
          uri: `fixture://guide/${fakeToken}`,
          name: `guide-${fakeToken}`,
          mimeType: 'text/plain',
          text: 'safe resource text',
        },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png', alt: fakeToken },
      ],
    }),
  });
  assert.equal(containsValue(result.events, fakeToken), false);
  assert.equal(containsValue(result.observed, fakeToken), false);
  assert.equal(containsValue(result.messages, fakeToken), false);
  const blocks = result.end.structuredContent;
  assert.equal(blocks[1].type, 'resource');
  assert.match(blocks[1].uri, /^fixture:\/\/guide\//);
  assert.equal(blocks[1].text, 'safe resource text');
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[2].data, 'AAECAw==');
  assert.equal(blocks[2].mimeType, 'image/png');
});
