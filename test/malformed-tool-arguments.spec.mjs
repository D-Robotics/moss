#!/usr/bin/env node
/**
 * One malformed tool call must not abort the turn.
 *
 * When a gateway answers JSON instead of a stream, the buffered parser threw
 * on unparseable `tool_calls[].function.arguments` — the model never saw the
 * bad call and the whole response was lost. The streaming parser already
 * recovers (first balanced object, or the raw text as `partialArgs`); the
 * buffered path now does the same.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { createHttpStreamFunction } from '../dist/provider/pi-ai-http-transport.js';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** One buffered OpenAI response carrying the given raw argument text. */
async function eventsFor(rawArguments) {
  const stub = await listen((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'exec', arguments: rawArguments } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        })
      );
    });
  });
  try {
    const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
    const stream = createHttpStreamFunction({
      providerLabel: 'Test',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      baseUrl,
    });
    return await collect(
      stream(
        { api: 'openai-chat', provider: 'test', id: 'gpt-4o', baseUrl },
        { messages: [{ role: 'user', content: 'hi' }] },
        {}
      )
    );
  } finally {
    await stub.close();
  }
}

{
  const events = await eventsFor('{"command":"ls -la"} trailing garbage');
  const call = events.find((event) => event.type === 'toolcall_end');
  assert.ok(call, `no tool call in: ${JSON.stringify(events).slice(0, 300)}`);
  assert.deepEqual(call.toolCall.arguments, { command: 'ls -la' });
  assert.ok(
    events.some((event) => event.type === 'done'),
    'the turn still finished'
  );
}

{
  const events = await eventsFor('not json at all');
  const call = events.find((event) => event.type === 'toolcall_end');
  assert.ok(call, 'the bad call is delivered, not thrown');
  assert.deepEqual(call.toolCall.arguments, {});
  assert.equal(call.toolCall.partial, true);
  assert.equal(call.toolCall.partialArgs, 'not json at all');
  assert.ok(
    events.some((event) => event.type === 'done'),
    'the turn still finished'
  );
}

console.log('[PASS] malformed-tool-arguments');
