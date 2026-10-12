import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { MossAgent, InMemorySessionStore } from '../dist/index.js';
import { redactEgress } from '../dist/safety/tool-output-redact.js';

test(
  'a real public run redacts a 100KB line and retains bounded evidence within the original 5s',
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const secret = 'sk-' + 'z'.repeat(40);
    const passed = '..\n' + '-'.repeat(70) + '\nRan 2 tests in 0.001s\n\nOK';
    assert.equal(passed.length, 99);
    const raw = `api_key="${secret}"\n${'x'.repeat(100_000)}\n${passed}`;
    const agent = new MossAgent({
      sessionStore: new InMemorySessionStore(),
      domainPrompt: false,
      enableCompaction: false,
      enableFollowUpGuard: false,
      hooks: { onBeforeToolExec: async () => ({ approved: true }) },
      llmProvider: {
        id: 'long-line',
        capabilities: { streaming: false },
        async complete() {
          return ++calls === 1
            ? {
                stopReason: 'tool_use',
                content: [{ type: 'tool_use', id: 'bounded', name: 'device_exec', input: {} }],
              }
            : { stopReason: 'end_turn', content: [{ type: 'text', text: 'finished' }] };
        },
      },
    });
    agent.tools.register({
      name: 'device_exec',
      description: 'Real bounded fixture',
      inputSchema: { type: 'object', properties: {} },
      metadata: { sideEffectClass: 'readonly' },
      execute: async () => raw,
    });
    try {
      const started = performance.now();
      const events = [];
      for await (const event of agent.streamChat('long-line', 'Run the fixture', {
        deviceConfigured: true,
      }))
        events.push(event);
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 5000, `original 5000ms budget exceeded: ${elapsedMs}ms`);
      const ends = events.filter((event) => event.type === 'tool_end');
      assert.equal(ends.length, 1);
      assert.ok(Buffer.byteLength(ends[0].content, 'utf8') < 26_000);
      assert.ok(ends[0].content.includes('tokens truncated'));
      assert.ok(ends[0].content.includes(passed));
      assert.ok(!ends[0].content.includes(secret));
      assert.equal(ends[0].result.length, 503);
      assert.doesNotMatch(ends[0].result, /Ran 2 tests/);
      assert.equal(calls, 2);
    } finally {
      await agent.close();
    }
  }
);

test('URL redaction retains the original regexp match grammar and untouched prefix/suffix bytes', () => {
  const secret = 'credential-123456789';
  const variants = new Set([secret, `${secret}%40tail`, `colon:${secret}/tail`]);
  const oldPattern = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):([^@&#\s'"`)\]]+)@/gi;
  const corpus = [];
  for (const prefix of ['', '123', '0..-+', 'prefix_', 'quoted "', 'x'.repeat(4000) + '\n']) {
    for (const scheme of ['http', 'a', 'A+B.-c', 'very-long-custom-scheme', 'a1']) {
      for (const user of ['', 'user', 'user"quoted', 'user%40encoded']) {
        for (const value of [...variants, '', 'a', 'process.env.VALUE']) {
          corpus.push(`${prefix}${scheme}://${user}:${value}@host/end`);
        }
      }
    }
  }
  corpus.push(
    `http://u:${secret}%40host`,
    `http://u:${secret}\n@host`,
    `http://u:${secret}&@host`,
    `http://u:${secret}#@host`,
    `http://u:${secret}')@host`,
    `http://u:${secret}]@host`,
    `http://u:${secret}://u:${secret}@host`,
    'http://u:missing/http://u:missing/'.repeat(100) + '\n' + `123custom://u:${secret}@end`,
    `http://u:no-at-sign`
  );
  for (const input of corpus) {
    const expected = input.replace(oldPattern, (full, user, value) =>
      variants.has(value) || value === `${secret}://u:${secret}` ? `${user}:[REDACTED]@` : full
    );
    assert.equal(redactEgress(input, {}), expected, `original URL grammar: ${input.slice(0, 120)}`);
  }
  assert.equal(
    redactEgress('api_key=a://:abcd@', {}),
    'api_key=[REDACTED]',
    'shape predicate retains empty user and four-character password'
  );
  assert.equal(
    redactEgress('api_key=a://:abc@', {}),
    'api_key=a://:abc@',
    'shape predicate retains the original minimum length'
  );
  assert.equal(redactEgress('api_key=process.env.VALUE', {}), 'api_key=process.env.VALUE');
});

test(
  'long non-scheme lines and nested failed URL suffixes do not delay a later real credential',
  { timeout: 5000 },
  () => {
    const secret = 'credential-123456789';
    const url = `123custom+scheme://:${secret}@host/end`;
    const redactedUrl = '123custom+scheme://:[REDACTED]@host/end';
    const started = performance.now();
    for (const prefix of ['x'.repeat(100_000) + '\n', 'http://u:missing/'.repeat(7000) + '\n']) {
      assert.equal(redactEgress(prefix + url, {}), prefix + redactedUrl);
    }
    assert.ok(performance.now() - started < 5000, 'original 5000ms budget retained');
  }
);
