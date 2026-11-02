import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { HttpRemoteCompactProvider } from '../dist/context/remote-compaction.js';

const staleText = 'synthetic-private-observation';
const fakeToken = `sk-${'A'.repeat(32)}`;
const opaquePassword = 'sYn7heticP4ssW0rd98';

async function captureRemoteRequest(messages) {
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'safe summary' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = new HttpRemoteCompactProvider({
      endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    await provider.compact({ messages, maxOutputTokens: 100, contextWindowTokens: 1000 });
    return received;
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('remote structured fragments cannot bypass redaction of their combined content', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'result-1',
          content: `Authorization: Bearer ${opaquePassword}`,
          structuredContent: [
            { type: 'text', text: 'Authorization: Bearer' },
            { type: 'text', text: opaquePassword },
            { type: 'resource', uri: 'fixture://safe/guide', text: opaquePassword },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
});

test('remote compaction withholds unverified legacy structured text', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'legacy',
          structuredContent: [
            { type: 'text', text: staleText },
            { type: 'resource', uri: 'fixture://safe/guide', text: staleText },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(staleText), false);
  assert.equal(received.messages[0].content[0].structuredContent[0].uri, '[REDACTED]');
});

test('remote tool input arrays cannot override the redaction traversal', async () => {
  const items = ['safe'];
  Object.defineProperty(items, 'map', { value: () => [{ password: opaquePassword }] });
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [{ type: 'tool_use', id: 'call-1', name: 'fixture', input: { items } }],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
  assert.deepEqual(received.messages[0].content[0].input.items, ['safe']);
});

test('remote tool inputs redact credential flags across argument arrays', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: { argv: ['--password', opaquePassword, '--verbose'] },
        },
      ],
    },
  ]);
  const payload = JSON.stringify(received);
  assert.equal(payload.includes(opaquePassword), false);
  assert.match(payload, /--verbose/);
});

test('remote tool inputs redact short credential flags in argument arrays', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: {
            mysql: ['mysql', '-p', opaquePassword],
            curl: ['curl', '-u', `fixture:${opaquePassword}`],
          },
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
});

test('remote tool inputs redact camel-case credential fields', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: { secretKey: opaquePassword, secret_key: opaquePassword, note: 'safe diagnostic' },
        },
      ],
    },
  ]);
  const payload = JSON.stringify(received);
  assert.equal(payload.includes(opaquePassword), false);
  assert.match(payload, /safe diagnostic/);
});

test('remote compaction sanitizes tool inputs and assistant thinking', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      thinking: [`Authorization: Bearer ${opaquePassword}`],
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: { password: opaquePassword, note: 'safe diagnostic' },
        },
      ],
    },
  ]);
  const payload = JSON.stringify(received);
  assert.equal(payload.includes(opaquePassword), false);
  assert.match(payload, /safe diagnostic/);
});

test('remote resource metadata does not repeat credentials recognized in content', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'result-1',
          content: `Authorization: Bearer ${opaquePassword}`,
          structuredContent: [
            { type: 'resource', uri: `fixture://guide/${opaquePassword}`, name: opaquePassword },
            { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
  assert.equal(received.messages[0].content[0].structuredContent[1].uri, 'fixture://safe/guide');
});

test('remote metadata does not repeat URL-encoded credential values', async () => {
  const token = 'sYn7heticP4ss+part/98';
  const encoded = encodeURIComponent(token).replace('%2F', '%2f');
  const fullyEncoded = Array.from(token, (char) => `%${char.charCodeAt(0).toString(16)}`).join('');
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          content: `Authorization: Bearer ${token}`,
          structuredContent: [
            { type: 'resource', uri: `fixture://guide/${encoded}` },
            { type: 'resource', uri: `fixture://guide/${fullyEncoded}` },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(encoded), false);
  assert.equal(JSON.stringify(received).includes(fullyEncoded), false);
});

test('already-redacted content cannot validate legacy resource metadata', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'result-1',
          content: 'Authorization: Bearer [REDACTED]',
          structuredContent: [
            { type: 'resource', uri: `fixture://guide/${opaquePassword}`, name: opaquePassword },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
});

test('remote structured arrays cannot override redaction traversal', async () => {
  const structuredContent = [{ type: 'resource', uri: 'fixture://safe/guide' }];
  Object.defineProperty(structuredContent, 'flatMap', {
    value: () => [{ type: 'resource', uri: `fixture://guide/${fakeToken}` }],
  });
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [{ type: 'tool_result', content: 'safe', structuredContent }],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(fakeToken), false);
  assert.equal(received.messages[0].content[0].structuredContent[0].uri, 'fixture://safe/guide');
});

test('remote header arrays and attached curl credentials are sanitized', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: {
            rawHeaders: ['Authorization', `Bearer ${opaquePassword}`, 'Content-Type', 'text/plain'],
            argv: ['curl', `--user=alice:${opaquePassword}`],
          },
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
  assert.match(JSON.stringify(received), /text\/plain/);
});

test('remote ordinary diagnostic arrays remain intact', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'fixture',
          input: {
            lines: ['-p', 'robot-port = 2222'],
            logLines: ['curl', '-p', 'robot-port = 2222'],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(received.messages[0].content[0].input.lines, ['-p', 'robot-port = 2222']);
  assert.deepEqual(received.messages[0].content[0].input.logLines, [
    'curl',
    '-p',
    'robot-port = 2222',
  ]);
});

test('remote compaction does not send stale structured text or sensitive metadata', async () => {
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'safe summary', tokens_saved: 1 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = new HttpRemoteCompactProvider({
      endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    const result = await provider.compact({
      messages: [
        {
          role: 'user',
          timestamp: 0,
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'result-1',
              content: '[redacted]',
              structuredContent: [
                { type: 'text', text: staleText },
                {
                  type: 'resource',
                  uri: `fixture://guide/${fakeToken}`,
                  name: 'safe guide',
                  mimeType: 'text/plain',
                  text: staleText,
                },
                { type: 'image', data: 'AAECAw==', mimeType: 'image/png', alt: fakeToken },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'result-2',
              content: 'safe resource text',
              structuredContent: [
                {
                  type: 'resource',
                  uri: 'fixture://guide/safe',
                  name: 'safe reference',
                  text: 'safe resource text',
                },
              ],
            },
          ],
        },
      ],
      maxOutputTokens: 100,
      contextWindowTokens: 1000,
    });
    assert.equal(result.summary, 'safe summary');
    const payload = JSON.stringify(received);
    assert.equal(payload.includes(staleText), false);
    assert.equal(payload.includes(fakeToken), false);
    assert.match(payload, /safe reference/);
    assert.match(payload, /fixture:\/\/guide\/safe/);
    const [stale, safe] = received.messages[0].content;
    assert.equal(stale.content, '[redacted]');
    assert.equal(stale.structuredContent[0].type, 'resource');
    assert.equal(stale.structuredContent[0].uri, '[REDACTED]');
    assert.equal(stale.structuredContent[0].name, undefined);
    assert.equal(stale.structuredContent[0].text, undefined);
    assert.match(stale.structuredContent[1].text, /image attachment omitted/);
    assert.equal(payload.includes('AAECAw=='), false);
    assert.deepEqual(safe.structuredContent[0], {
      type: 'resource',
      uri: 'fixture://guide/safe',
      name: 'safe reference',
      text: 'safe resource text',
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
