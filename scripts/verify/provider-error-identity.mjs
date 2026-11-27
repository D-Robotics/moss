import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.MOSS_VERIFY_DIST_ROOT ?? path.resolve('dist');
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const { PiAiLLMProvider } = await load('provider/pi-ai-adapter.js');
const { mossErrorToOutcome, mossErrorFromOutcome } = await load('errors.js');
const { classifyProviderError } = await load('provider/error-classify.js');
for (const entry of ['complete', 'stream']) {
  const provider = new PiAiLLMProvider({
    apiKey: 'offline',
    model: { id: 'offline', provider: 'custom', api: 'openai-completions' },
    streamFn: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw Object.assign(new Error('Synthetic localized capacity rejection'), {
              code: 'context_length_exceeded',
              source: 'upstream',
              secret: 'DO_NOT_FORWARD',
            });
          },
        };
      },
    }),
  });
  const request = {
    model: 'offline',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'Summarize.' }],
    maxTokens: 128,
  };
  await assert.rejects(
    entry === 'complete' ? provider.complete(request) : provider.stream(request, () => {}),
    (error) => {
      assert.equal(error.code, 'PROVIDER_CONTEXT_OVERFLOW');
      assert.equal(error.source, 'upstream');
      assert.equal(error.providerCode, 'context_length_exceeded');
      const serialized = JSON.stringify(mossErrorToOutcome(error));
      assert.doesNotMatch(serialized, /DO_NOT_FORWARD|secret|cause|stack/);
      const rebuilt = mossErrorFromOutcome(JSON.parse(serialized));
      assert.equal(rebuilt.code, error.code);
      assert.equal(rebuilt.source, error.source);
      assert.equal(rebuilt.providerCode, error.providerCode);
      assert.equal(
        classifyProviderError({ code: rebuilt.code, errorMessage: rebuilt.message }).category,
        'context_length_exceeded'
      );
      return true;
    }
  );
}
console.log(
  'PASS typed capacity identity survives complete/stream and JSON outcome without raw payloads'
);

const { processEvent } = await load('provider/pi-ai-stream-parser.js');
assert.throws(
  () =>
    processEvent(
      {
        type: 'error',
        error: {
          code: 'context_length_exceeded',
          errorMessage: 'Synthetic capacity error',
          source: 'gateway',
        },
      },
      [],
      (url) => url
    ),
  (error) => {
    assert.equal(error.code, 'PROVIDER_CONTEXT_OVERFLOW');
    assert.equal(error.source, 'gateway');
    assert.equal(error.providerCode, 'context_length_exceeded');
    return true;
  }
);

const textOnly = new PiAiLLMProvider({
  apiKey: 'offline',
  model: { id: 'offline', provider: 'custom', api: 'openai-completions' },
  streamFn: async function* () {
    yield { type: 'error', error: { errorMessage: 'context_length_exceeded' } };
  },
});
await assert.rejects(
  textOnly.stream(
    {
      model: 'offline',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'synthetic' }],
      maxTokens: 128,
    },
    () => {}
  ),
  (error) => {
    assert.equal(error.code, 'PROVIDER_CONTEXT_OVERFLOW');
    assert.equal(error.providerCode, undefined);
    assert.equal(error.source, undefined);
    return true;
  }
);
